import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  OpenBotAdapter,
  OpenBotError,
  type OpenBotRunObservation,
} from "../../../packages/backends/src/openbot.ts";
import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

const agentsSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      title: z.string().optional(),
      hidden: z.boolean().optional(),
      endpoint: z.string().nullable().optional(),
    }),
  ),
});
const channelsSchema = z.object({
  channels: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      agentIds: z.array(z.string().min(1)),
      threadId: z.string().min(1),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

export class OpenBotGateway {
  private readonly base?: URL;
  private readonly adapter: OpenBotAdapter;
  private readonly scopedReadToken?: string;
  private readonly scopedReadSigningKey?: string;
  private probeCache?: { expiresAt: number; result: ReturnType<OpenBotAdapter["probe"]> };

  constructor(config: Config) {
    this.scopedReadToken = config.openbotScopedReadToken?.trim();
    this.scopedReadSigningKey = config.openbotScopedReadSigningKey?.trim();
    if (config.openbotEnabled) {
      if (!config.openbotBaseUrl) throw new Error("OPENBOT_BASE_URL is required when enabled");
      const base = new URL(config.openbotBaseUrl);
      if (
        base.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
        base.pathname !== "/" ||
        base.search ||
        base.hash ||
        base.username ||
        base.password
      )
        throw new Error("OPENBOT_BASE_URL must be a local HTTP origin");
      this.base = base;
    }
    const base = this.base;
    this.adapter = new OpenBotAdapter({
      enabled: config.openbotEnabled,
      transport: base
        ? {
            runtimeUrl: new URL("/api/copilotkit", base).toString(),
            socketUrl: new URL("/socket", base).toString().replace(/^http/, "ws"),
            request: (path, init) => fetch(new URL(path, base), { ...init, redirect: "error" }),
          }
        : undefined,
    });
  }

  probe() {
    const now = Date.now();
    if (this.probeCache && this.probeCache.expiresAt > now) return this.probeCache.result;
    const result = this.adapter.probe(AbortSignal.timeout(3000)).catch((error) => {
      if (this.probeCache?.result === result) this.probeCache = undefined;
      throw error;
    });
    this.probeCache = { expiresAt: now + 30_000, result };
    return result;
  }

  async agents() {
    const { agents } = await this.json("/api/agents", agentsSchema);
    return { agents: agents.filter((agent) => !agent.hidden) };
  }

  async eligibleBot(botId: string) {
    const matches = (await this.agents()).agents.filter(
      (agent) => agent.id === botId || agent.name.toLowerCase() === botId.toLowerCase(),
    );
    const bot = matches.length === 1 ? matches[0] : undefined;
    if (!bot) throw new AppError("The named Bot is unavailable or ambiguous", 404);
    if (bot.endpoint !== null)
      throw new AppError("The named Bot's external endpoint cannot be verified as tool-free", 409);
    try {
      if (!(await this.adapter.hasNoEffectiveGrants(bot.id)))
        throw new AppError(
          "The named Bot has tool or host access and cannot take a text-only task",
          409,
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("The named Bot's effective authority could not be verified", 502);
    }
    return bot;
  }

  createTaskChannel(botId: string) {
    return this.adapter.createConversation(botId, AbortSignal.timeout(10000));
  }

  async bindScopedRead(
    owner: string,
    taskId: string,
    botId: string,
    threadId: string,
    runId: string,
    path: string,
  ) {
    if (
      !this.scopedReadToken ||
      !this.scopedReadSigningKey ||
      this.scopedReadSigningKey.length < 32 ||
      this.scopedReadSigningKey === this.scopedReadToken
    )
      throw new AppError("Scoped reads are unavailable", 503);
    const tuple = JSON.stringify([owner, taskId, botId, threadId, runId, path]);
    const runSecret = createHmac("sha256", this.scopedReadSigningKey)
      .update(`run:${tuple}`)
      .digest("base64url");
    const signature = createHmac("sha256", this.scopedReadSigningKey)
      .update(tuple)
      .digest("base64url");
    const response = await fetch(new URL("/api/openmuse/scoped-runs", this.requireBase()), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.scopedReadToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ owner, taskId, botId, threadId, runId, path, runSecret, signature }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new AppError("Scoped reads are unavailable", 503);
    return runSecret;
  }

  runText(
    botId: string,
    threadId: string,
    runId: string,
    text: string,
    onStartup: () => Promise<void>,
    signal: AbortSignal,
    onEvent?: (event: OpenBotRunObservation) => Promise<void>,
    scopeSecret?: string,
  ) {
    return this.adapter.runText(
      botId,
      threadId,
      runId,
      text,
      onStartup,
      signal,
      onEvent,
      scopeSecret,
    );
  }

  reconnectRun(
    botId: string,
    threadId: string,
    runId: string,
    cursor: string | undefined,
    onEvent: (event: OpenBotRunObservation) => Promise<void>,
    signal: AbortSignal,
  ) {
    return this.adapter.reconnectRun(botId, threadId, runId, cursor, onEvent, signal);
  }

  textResult(botId: string, threadId: string, messageIds: string[]) {
    return this.adapter.textResult(botId, threadId, messageIds);
  }

  channels(cursor?: string) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.json(`/api/channels${query}`, channelsSchema);
  }

  async createChannel(agentId: string) {
    try {
      return await this.adapter.createConversation(agentId, AbortSignal.timeout(10000));
    } catch (error) {
      if (error instanceof OpenBotError && error.outcomeUnknown)
        throw new AppError(
          "OpenBot may have created this conversation. Refresh conversations before trying again.",
          409,
        );
      if (error instanceof OpenBotError)
        throw new AppError(error.message, error.status === 401 ? 401 : 502);
      throw error;
    }
  }

  async runtime(request: Request, rest: string) {
    const base = this.requireBase();
    const target = new URL(`/api/copilotkit/${rest}`, base);
    if (!target.pathname.startsWith("/api/copilotkit/"))
      throw new AppError("Invalid OpenBot runtime path", 400);
    target.search = new URL(request.url).search;
    const headers = new Headers();
    for (const name of ["accept", "content-type"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        duplex: "half",
        redirect: "error",
        signal: request.signal,
      } as RequestInit);
    } catch {
      throw new AppError("OpenBot is unavailable", 502);
    }
    return new Response([204, 205, 304].includes(response.status) ? null : response.body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") ?? "application/json" },
    });
  }

  private requireBase() {
    if (!this.base) throw new AppError("OpenBot is not configured", 503);
    return this.base;
  }

  private async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const base = this.requireBase();
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError("OpenBot is unavailable", 502);
    }
    if (!response.ok) throw new AppError(`OpenBot request failed (${response.status})`, 502);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new AppError("OpenBot returned an incompatible response", 502);
    return parsed.data;
  }
}
