/**
 * The bridge's only HTTP surface: an AG-UI run endpoint plus a liveness probe.
 *
 * The OpenMuse server speaks AG-UI to this; Hermes is behind `upstream`. Nothing in a
 * request can redirect, authenticate, or configure the upstream.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  runError,
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
} from "./agui.ts";
import type { BridgeConfig } from "./config.ts";
import { ConversationError, Conversations } from "./conversations.ts";
import type { UpstreamAgent } from "./upstream.ts";

const RunInput = z
  .object({
    threadId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    messages: z.array(z.object({ role: z.string() }).passthrough()).max(1000),
  })
  .passthrough();

type AguiMessage = { role: string; content?: unknown };

/** The last user message's text. Text parts are joined; non-text parts are ignored. */
export function userText(messages: AguiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) =>
          part && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .filter(Boolean)
        .join("\n");
    return "";
  }
  return "";
}

/** Hash both sides first so the comparison is constant time and length-agnostic. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given?.startsWith("Bearer ")) return false;
  const provided = createHash("sha256").update(given.slice("Bearer ".length).trim()).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(provided, wanted);
}

export function createBridgeApp(config: BridgeConfig, deps: { upstream: UpstreamAgent }): Hono {
  const app = new Hono();
  const conversations = new Conversations(config);
  app.onError((error, c) => {
    if (error instanceof ConversationError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return c.json({ error: "Invalid conversation input" }, 400);
    return c.json({ error: "Conversation request failed" }, 502);
  });

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.use("/conversations*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), config.bridgeToken))
      return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.post("/conversations", async (c) => {
    const input = z
      .object({ id: z.string().min(1).max(200).optional() })
      .strict()
      .parse(await c.req.json());
    const result = await conversations.create(input.id);
    return c.json(result, result.existing ? 200 : 201);
  });

  app.get("/conversations", async (c) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(10000).default(0),
      })
      .parse(c.req.query());
    return c.json(await conversations.list(query.limit, query.offset));
  });

  app.get("/conversations/:id/messages", async (c) =>
    c.json(await conversations.messages(c.req.param("id"))),
  );

  app.patch("/conversations/:id", async (c) => {
    const update = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0)
      .parse(await c.req.json());
    return c.json(await conversations.update(c.req.param("id"), update));
  });

  app.get("/health", async (c) => {
    let upstream = "unreachable";
    try {
      const probe = await deps.upstream.probe();
      if (probe.ok) upstream = "ok";
    } catch {
      upstream = "unreachable";
    }
    // The bridge being up while Hermes is down is a degraded state the phone must see.
    return c.json({ ok: true, upstream });
  });

  app.post("/run", async (c) => {
    if (!tokenMatches(c.req.header("authorization"), config.bridgeToken))
      return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid run input" }, 400);
    }
    const parsed = RunInput.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid run input" }, 422);
    const input = parsed.data;

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());

      let messageId = `msg_${input.runId}`;
      let textSequence = 0;
      let streaming = false;
      let failed = false;
      const send = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event) });

      await send(runStarted(input.threadId, input.runId));
      try {
        for await (const event of deps.upstream.run(
          { threadId: input.threadId, runId: input.runId, text: userText(input.messages) },
          controller.signal,
        )) {
          if (controller.signal.aborted) return;
          if (event.type === "text") {
            if (!streaming) {
              await send(textMessageStart(messageId));
              streaming = true;
            }
            await send(textMessageContent(messageId, event.delta));
            continue;
          }
          if (event.type === "tool_start") {
            if (streaming) {
              await send(textMessageEnd(messageId));
              streaming = false;
              messageId = `msg_${input.runId}_${++textSequence}`;
            }
            await send({
              type: EventType.TOOL_CALL_START,
              toolCallId: event.id,
              toolCallName: event.name,
            });
            await send({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: event.id,
              delta: JSON.stringify(event.args),
            });
            await send({ type: EventType.TOOL_CALL_END, toolCallId: event.id });
            continue;
          }
          if (event.type === "tool_result") {
            await send({
              type: EventType.TOOL_CALL_RESULT,
              toolCallId: event.id,
              messageId: `result_${event.id}`,
              role: "tool",
              content: JSON.stringify({
                preview: event.preview,
                failed: event.failed,
                ...(event.attributionUnknown ? { attributionUnknown: true } : {}),
                fullOutputAvailable: false,
              }),
            });
            continue;
          }
          if (event.type === "error") {
            failed = true;
            await send(runError(event.message));
            break;
          }
          break;
        }
      } catch (error) {
        failed = true;
        if (!controller.signal.aborted)
          await send(runError(error instanceof Error ? error.message : "Upstream failed"));
      }
      // A cancelled turn stops where it is; it must not claim a successful finish.
      if (controller.signal.aborted) return;
      if (streaming) await send(textMessageEnd(messageId));
      if (!failed) await send(runFinished(input.threadId, input.runId));
    });
  });

  return app;
}
