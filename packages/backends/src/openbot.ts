import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/core";
import { IntelligenceAgent } from "@copilotkit/core";
import type { Subscription } from "rxjs";
import { z } from "zod";

/** Verified against OpenBot a96d88c6 and its public CopilotKit runtime 1.70.1. */
export const OPENBOT_CONTRACT_REF = "a96d88c6fb75385842529d7db7d463f4a8c4a86e";

/**
 * Inject an authenticated, per-person transport from the host application.
 * Paths are relative to the OpenBot deployment. The transport owns its session;
 * this adapter never accepts a shared administrator token or calls global fetch.
 */
export interface OpenBotTransport {
  runtimeUrl: string;
  socketUrl?: string;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export type OpenBotErrorCode =
  | "disabled"
  | "not_configured"
  | "invalid_input"
  | "invalid_response"
  | "authentication_required"
  | "refused"
  | "http_error"
  | "unavailable"
  | "cancelled";

export class OpenBotError extends Error {
  constructor(
    readonly code: OpenBotErrorCode,
    message: string,
    readonly status?: number,
    readonly rule?: string,
    /** An action may have happened. Reconcile before offering another attempt. */
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "OpenBotError";
  }
}

const nonempty = z.string().min(1);
const capabilitiesSchema = z.object({
  mode: z.literal("intelligence"),
  durableHistory: z.boolean(),
  generativeUi: z.boolean(),
});
const userSchema = z.object({ user: z.object({ id: nonempty }) });
const computerStatusSchema = z.object({
  botId: nonempty,
  state: z.enum(["absent", "starting", "ready", "unreachable"]),
  reason: z.string().optional(),
});
const controlSchema = z.object({
  holder: z.enum(["bot", "human"]),
  since: nonempty,
  requested: z.boolean(),
  reason: z.string().optional(),
  requestedAt: z.string().optional(),
  secretWanted: z.string().optional(),
});
const snapshotSchema = z.object({
  snapshotId: z.number().int().nonnegative(),
  url: nonempty,
  title: z.string(),
  truncated: z.boolean(),
  elements: z.array(
    z.object({
      ref: nonempty,
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
      type: z.string().optional(),
      disabled: z.boolean().optional(),
      checked: z.boolean().optional(),
    }),
  ),
});
const navigationSchema = z.object({
  url: nonempty,
  title: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  elapsedMs: z.number().nonnegative(),
});
const channelSchema = z.object({
  channel: z.object({ id: nonempty, threadId: nonempty, agentIds: z.array(nonempty).min(1) }),
});
const grantsSchema = z.object({ tools: z.array(z.unknown()), skills: z.array(z.unknown()) });
const hostSchema = z.object({
  grants: z.array(z.object({ botId: nonempty, revoked: z.boolean() })),
  pending: z.array(z.object({ botId: nonempty })),
});
const historySchema = z.object({
  messages: z.array(z.object({ id: nonempty, role: z.string(), content: z.unknown() })),
});
const errorSchema = z.object({ error: z.string().optional(), rule: z.string().optional() });

export type OpenBotComputerStatus = z.infer<typeof computerStatusSchema>;
export type OpenBotControl = z.infer<typeof controlSchema>;
export type OpenBotSnapshot = z.infer<typeof snapshotSchema>;
export type OpenBotNavigation = z.infer<typeof navigationSchema>;
export type OpenBotProbe =
  | { state: "disabled" | "not_configured" | "authentication_required" }
  | { state: "unavailable"; reason: string }
  | ({ state: "authenticated"; userId: string } & z.infer<typeof capabilitiesSchema>);

/**
 * Future integration seam; constructing it does not connect to OpenBot.
 * The caller must enforce OpenMuse proposals before dispatching external writes.
 * OpenBot's own policy/audit gateway remains authoritative for every request.
 */
export class OpenBotAdapter {
  readonly unsupportedCapabilities = Object.freeze([
    "gmail",
    "calendar",
    "pdf",
    "approval_persistence",
  ] as const);

  constructor(
    private readonly options: {
      enabled?: boolean;
      agentId?: string;
      transport?: OpenBotTransport;
    } = {},
  ) {}

  /** Configure a compatible public CopilotKit client. This is NOT an AG-UI SSE URL. */
  runtime() {
    const transport = this.requireTransport();
    if (!this.options.agentId?.trim()) {
      throw new OpenBotError(
        "not_configured",
        "Choose an OpenBot agent before configuring its runtime.",
      );
    }
    const runtimeUrl = httpUrl(transport.runtimeUrl);
    return {
      runtimeUrl,
      agentId: identifier(this.options.agentId),
      mode: "intelligence" as const,
      credentials: "include" as const,
    };
  }

  /** Authenticated API reachability, not evidence that a model can complete a run. */
  async probe(signal?: AbortSignal): Promise<OpenBotProbe> {
    if (this.options.enabled !== true) return { state: "disabled" };
    if (!this.options.transport) return { state: "not_configured" };
    try {
      const { user } = await this.json("/api/me", userSchema, { signal });
      const capabilities = await this.json("/api/capabilities", capabilitiesSchema, { signal });
      return { state: "authenticated", userId: user.id, ...capabilities };
    } catch (error) {
      if (!(error instanceof OpenBotError)) throw error;
      if (error.code === "authentication_required") return { state: "authentication_required" };
      return { state: "unavailable", reason: error.message };
    }
  }

  async createConversation(agentId: string, signal?: AbortSignal) {
    const id = identifier(agentId);
    const { channel } = await this.json(
      "/api/channels",
      channelSchema,
      {
        method: "POST",
        body: JSON.stringify({ agentIds: [id] }),
        signal,
      },
      true,
    );
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== id) {
      throw new OpenBotError(
        "invalid_response",
        "OpenBot returned a channel for a different agent.",
        undefined,
        undefined,
        true,
      );
    }
    return { channelId: channel.id, threadId: channel.threadId, agentIds: channel.agentIds };
  }

  async hasNoEffectiveGrants(agentId: string) {
    const id = identifier(agentId);
    const grants = await this.json(`/api/plugins/for/${encodeURIComponent(id)}`, grantsSchema);
    const host = await this.json("/api/host-access", hostSchema);
    return (
      grants.tools.length === 0 &&
      grants.skills.length === 0 &&
      !host.grants.some((grant) => grant.botId === id && !grant.revoked) &&
      !host.pending.some((operation) => operation.botId === id)
    );
  }

  async runText(
    botId: string,
    threadId: string,
    runId: string,
    text: string,
    onStartup: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ terminal: "finished" | "error" | "unconfirmed"; messageIds: string[] }> {
    const transport = this.requireTransport();
    if (!transport.socketUrl)
      throw new OpenBotError("not_configured", "OpenBot realtime is unavailable.");
    const id = identifier(botId);
    const agent = new IntelligenceAgent({
      url: transport.socketUrl,
      runtimeUrl: transport.runtimeUrl,
      agentId: id,
      fetch: async (url, init) => {
        const target = new URL(String(url));
        const response = await transport.request(target.pathname + target.search, init);
        if (target.pathname.endsWith("/run") && response.ok) {
          const started = z.object({ threadId: nonempty, runId: nonempty }).safeParse(
            await response
              .clone()
              .json()
              .catch(() => undefined),
          );
          if (
            !started.success ||
            started.data.threadId !== threadId ||
            started.data.runId !== runId
          )
            throw new OpenBotError(
              "invalid_response",
              "OpenBot acknowledged a different run.",
              undefined,
              undefined,
              true,
            );
          await onStartup();
        }
        return response;
      },
    });
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [{ id: randomUUID(), role: "user", content: text }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      const messageIds: string[] = [];
      let subscription: Subscription | undefined;
      const finish = (result: "finished" | "error" | "unconfirmed") => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        resolve({ terminal: result, messageIds });
      };
      subscription = agent.run(input).subscribe({
        next: (event) => {
          if (event.type === "RUN_STARTED") {
            started = event.threadId === threadId && event.runId === runId;
            return;
          }
          if (
            event.type === "TEXT_MESSAGE_START" &&
            started &&
            event.role === "assistant" &&
            typeof event.messageId === "string"
          ) {
            messageIds.push(event.messageId);
            return;
          }
          if (event.type !== "RUN_FINISHED" && event.type !== "RUN_ERROR") return;
          if (event.threadId !== threadId || event.runId !== runId) return;
          finish(event.type === "RUN_FINISHED" ? "finished" : "error");
        },
        error: (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
        complete: () => finish("unconfirmed"),
      });
      if (settled) subscription.unsubscribe();
      signal?.addEventListener("abort", () => finish("unconfirmed"), { once: true });
    });
  }

  async textResult(botId: string, threadId: string, messageIds: string[]): Promise<string> {
    if (!messageIds.length) return "";
    const history = await this.json(
      `/api/copilotkit/threads/${encodeURIComponent(identifier(threadId))}/messages?agentId=${encodeURIComponent(identifier(botId))}`,
      historySchema,
    );
    const ids = new Set(messageIds);
    const answers = history.messages
      .filter((message) => message.role === "assistant" && ids.has(message.id))
      .map((message) => (typeof message.content === "string" ? message.content.trim() : ""))
      .filter(Boolean);
    return answers.length === ids.size ? answers.join("\n\n") : "";
  }

  async computerStatus(botId: string, signal?: AbortSignal): Promise<OpenBotComputerStatus> {
    const result = await this.json(computerPath(botId, "status"), computerStatusSchema, { signal });
    if (result.botId !== botId.trim()) {
      throw new OpenBotError("invalid_response", "OpenBot returned another Bot's computer status.");
    }
    return result;
  }

  snapshot(botId: string, signal?: AbortSignal): Promise<OpenBotSnapshot> {
    return this.json(computerPath(botId, "snapshot"), snapshotSchema, { method: "POST", signal });
  }

  async navigate(
    botId: string,
    input: { url: string; toolCallId?: string },
    signal?: AbortSignal,
  ): Promise<OpenBotNavigation> {
    const url = httpUrl(input.url);
    return this.json(
      computerPath(botId, "navigate"),
      navigationSchema,
      {
        method: "POST",
        body: JSON.stringify({
          url,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        }),
        signal,
      },
      true,
    );
  }

  computerControl(botId: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(computerPath(botId, "control"), controlSchema, { signal });
  }

  requestControl(botId: string, reason: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(
      computerPath(botId, "control/request"),
      controlSchema,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
        signal,
      },
      true,
    );
  }

  takeControl(botId: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(
      computerPath(botId, "control/take"),
      controlSchema,
      { method: "POST", signal },
      true,
    );
  }

  releaseControl(botId: string, signal?: AbortSignal): Promise<OpenBotControl> {
    return this.json(
      computerPath(botId, "control/release"),
      controlSchema,
      { method: "POST", signal },
      true,
    );
  }

  private requireTransport(): OpenBotTransport {
    if (this.options.enabled !== true)
      throw new OpenBotError("disabled", "OpenBot integration is disabled.");
    if (!this.options.transport)
      throw new OpenBotError(
        "not_configured",
        "An authenticated OpenBot transport has not been configured.",
      );
    return this.options.transport;
  }

  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    mutates = false,
  ): Promise<T> {
    const transport = this.requireTransport();
    if (init.signal?.aborted)
      throw new OpenBotError("cancelled", "OpenBot request cancelled before dispatch.");
    let response: Response;
    try {
      response = await transport.request(path, {
        ...init,
        method: init.method ?? "GET",
        credentials: "include",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw new OpenBotError(
        init.signal?.aborted ? "cancelled" : "unavailable",
        "OpenBot did not return a response.",
        undefined,
        undefined,
        mutates,
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = errorSchema.safeParse(body);
      const code =
        response.status === 401
          ? "authentication_required"
          : response.status === 403
            ? "refused"
            : "http_error";
      throw new OpenBotError(
        code,
        detail.success && detail.data.error
          ? detail.data.error.slice(0, 1000)
          : `OpenBot request failed (${response.status}).`,
        response.status,
        detail.success ? detail.data.rule : undefined,
        mutates && (response.status >= 500 || response.status === 408),
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new OpenBotError(
        "invalid_response",
        "OpenBot returned an incompatible response.",
        response.status,
        undefined,
        mutates,
      );
    return parsed.data;
  }
}

function identifier(value: string): string {
  const id = value.trim();
  if (!id || id === "." || id === "..")
    throw new OpenBotError("invalid_input", "An OpenBot ID is required.");
  return id;
}

function computerPath(botId: string, operation: string): string {
  return `/api/computers/${encodeURIComponent(identifier(botId))}/${operation}`;
}

function httpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenBotError("invalid_input", "A valid HTTP(S) URL is required.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new OpenBotError(
      "invalid_input",
      "A valid HTTP(S) URL without embedded credentials is required.",
    );
  }
  return url.toString();
}
