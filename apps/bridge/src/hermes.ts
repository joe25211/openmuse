/**
 * Hermes API-server client. This is the only module that knows Hermes's wire format.
 *
 * Contract used (Hermes gateway `api_server` platform):
 *   POST /api/sessions                       { id, source }        -> create; id may be supplied
 *   POST /api/sessions/{id}/chat/stream      { message }           -> SSE frames
 *     event: assistant.delta    { message_id, delta }
 *     event: assistant.commentary { message_id, text }
 *     event: tool.progress      { message_id, tool_name, delta }
 *     event: approval.request   { ... }
 *     event: done | error
 */

import { Conversations } from "./conversations.ts";
import { sessionIdFor } from "./identity.ts";

export { sessionIdFor } from "./identity.ts";

import type { BridgeConfig } from "./config.ts";
import type { UpstreamAgent, UpstreamEvent } from "./upstream.ts";

interface SseFrame {
  event: string;
  data: string;
}

/** Split a byte stream into SSE frames. Handles CRLF, comments, and multi-line data. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (raw: string): SseFrame | null => {
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = parse(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const tail = parse(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function jsonOf(frame: SseFrame): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(frame.data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createHermesUpstream(config: BridgeConfig): UpstreamAgent {
  const headers = {
    Authorization: `Bearer ${config.hermesApiKey}`,
    "Content-Type": "application/json",
  };
  const base = config.hermesBaseUrl;
  const conversations = new Conversations(config);

  return {
    async probe(signal) {
      try {
        const response = await fetch(`${base}/v1/health`, {
          headers: { Authorization: `Bearer ${config.hermesApiKey}` },
          signal,
        });
        return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : "unreachable" };
      }
    },

    async *run(input, signal): AsyncGenerator<UpstreamEvent> {
      const sessionId = sessionIdFor(input.threadId);
      try {
        await conversations.create(input.threadId);
      } catch {
        yield { type: "error", message: "Conversation is unavailable or not owned by OpenMuse" };
        return;
      }
      if (signal.aborted) return;

      let response: Response;
      try {
        response = await fetch(
          `${base}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ message: input.text }),
            signal,
          },
        );
      } catch (error) {
        yield {
          type: "error",
          message:
            error instanceof Error && error.name === "AbortError"
              ? "The turn was cancelled"
              : "Hermes is unreachable",
        };
        return;
      }

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        yield {
          type: "error",
          message: `Hermes rejected the turn (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        };
        return;
      }

      let sawDone = false;
      let toolSequence = 0;
      const pendingTools = new Map<string, string[]>();
      const ambiguousTools = new Set<string>();
      for await (const frame of sseFrames(response.body)) {
        if (frame.event === "assistant.delta") {
          const { delta } = jsonOf(frame);
          if (typeof delta === "string" && delta) {
            yield { type: "text", delta };
          }
        } else if (frame.event === "tool.started") {
          const data = jsonOf(frame),
            name = String(data.tool_name || "unknown_tool");
          const id = `hermes-${input.runId}-${++toolSequence}`;
          const pending = pendingTools.get(name) || [];
          if (pending.length) ambiguousTools.add(name);
          pendingTools.set(name, [...pending, id]);
          yield { type: "tool_start", id, name, args: data.args ?? {} };
        } else if (frame.event === "tool.completed" || frame.event === "tool.failed") {
          const data = jsonOf(frame),
            name = String(data.tool_name || "unknown_tool");
          const id = pendingTools.get(name)?.shift();
          if (!id) {
            yield { type: "error", message: "Hermes returned an unmatched tool result" };
            return;
          }
          // The session stream omits call IDs. Overlap cannot be safely matched by name.
          const attributionUnknown = ambiguousTools.has(name);
          yield {
            type: "tool_result",
            id,
            preview: attributionUnknown
              ? "Result cannot be attributed: overlapping tool calls have no upstream call IDs."
              : String(data.preview || ""),
            failed: !attributionUnknown && frame.event === "tool.failed",
            ...(attributionUnknown ? { attributionUnknown: true } : {}),
          };
          if (!pendingTools.get(name)?.length) ambiguousTools.delete(name);
        } else if (
          frame.event === "error" ||
          frame.event === "run.failed" ||
          frame.event === "run.cancelled"
        ) {
          const { message } = jsonOf(frame);
          yield { type: "error", message: typeof message === "string" ? message : "Hermes failed" };
          return;
        } else if (frame.event === "done") {
          sawDone = true;
          break;
        }
      }
      // Partial output is not completion: a transport loss must never look successful.
      if (!sawDone) {
        yield { type: "error", message: "The Hermes turn ended without a result" };
        return;
      }
      yield { type: "done" };
    },
  };
}
