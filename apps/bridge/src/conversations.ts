import { randomUUID } from "node:crypto";
import { type Message, MessageSchema } from "@ag-ui/core";
import { z } from "zod";
import type { BridgeConfig } from "./config.ts";
import { ConversationIndex } from "./conversation-index.ts";
import { sessionIdFor } from "./hermes.ts";

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 | 503 = 502,
  ) {
    super(message);
  }
}
const sessionSchema = z.object({
  id: z.string().regex(/^om_[a-f0-9]{32}$/),
  source: z.literal("api_server"),
  title: z.string().nullish(),
  archived: z.boolean().optional(),
  started_at: z.number().optional(),
  last_active: z.number().nullish(),
  preview: z.string().nullish(),
});
export type HermesConversation = z.infer<typeof sessionSchema>;

/** Only the bridge knows Hermes routes or holds its bearer credential. */
export class Conversations {
  private readonly index: ConversationIndex;
  constructor(private readonly config: BridgeConfig) {
    this.index = new ConversationIndex(config.dataDir);
  }

  private view(row: HermesConversation) {
    return {
      id: row.id,
      title: row.title || "Untitled conversation",
      archived: Boolean(row.archived),
      updatedAt: new Date((row.last_active || row.started_at || 0) * 1000).toISOString(),
      preview: row.preview || "",
    };
  }

  async list(limit: number, offset: number) {
    const found = new Map<string, HermesConversation>();
    for (let page = 0; page < 50; page++) {
      const result = await this.request(
        `/api/sessions?source=api_server&limit=200&offset=${page * 200}`,
      );
      if (!Array.isArray(result.data))
        throw new ConversationError("Hermes returned invalid conversation data");
      for (const item of result.data) {
        const parsed = sessionSchema.safeParse(item);
        if (parsed.success) found.set(parsed.data.id, parsed.data);
      }
      if (!result.has_more) break;
      if (page === 49)
        throw new ConversationError("Conversation list exceeds the supported window");
    }
    await this.index.remember([...found.keys()]);
    for (const id of await this.index.ids()) {
      if (found.has(id)) continue;
      try {
        found.set(id, await this.get(id));
      } catch (error) {
        if (!(error instanceof ConversationError && error.status === 404)) throw error;
      }
    }
    const rows = [...found.values()]
      .map((row) => this.view(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return {
      conversations: rows.slice(offset, offset + limit),
      hasMore: rows.length > offset + limit,
    };
  }

  async messages(id: string) {
    await this.get(id);
    const body = await this.request(`/api/sessions/${id}/messages?limit=500&order=latest`);
    if (!Array.isArray(body.data))
      throw new ConversationError("Hermes returned invalid message history");
    const messages: Message[] = [];
    for (const [index, value] of body.data.entries()) {
      if (!value || typeof value !== "object")
        throw new ConversationError("Hermes returned invalid message history");
      const row = value as Record<string, unknown>;
      if (!["assistant", "user", "tool"].includes(String(row.role))) continue;
      const content =
        typeof row.content === "string"
          ? row.content
          : row.content == null
            ? ""
            : JSON.stringify(row.content);
      const candidate = {
        id: `${id}:${row.id ?? index}`,
        role: row.role,
        content,
        ...(row.role === "assistant" && Array.isArray(row.tool_calls)
          ? { toolCalls: row.tool_calls }
          : {}),
        ...(row.role === "tool" ? { toolCallId: row.tool_call_id } : {}),
      };
      const parsed = MessageSchema.safeParse(candidate);
      if (!parsed.success)
        throw new ConversationError("Hermes returned unsupported message history");
      messages.push(parsed.data);
    }
    return { messages };
  }

  async update(id: string, update: { title?: string; archived?: boolean }) {
    await this.get(id);
    await this.index.remember([id]);
    await this.request(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(update) });
    return this.view(await this.get(id));
  }

  private async request(path: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await fetch(`${this.config.hermesBaseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.hermesApiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ConversationError("Hermes is unreachable", 503);
    }
    if (response.status === 404) throw new ConversationError("Conversation not found", 404);
    if (response.status === 409) throw new ConversationError("Conversation conflict", 409);
    if (!response.ok)
      throw new ConversationError(`Hermes request failed (HTTP ${response.status})`);
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ConversationError("Hermes returned invalid conversation data");
    }
  }

  async get(id: string): Promise<HermesConversation> {
    if (!/^om_[a-f0-9]{32}$/.test(id)) throw new ConversationError("Conversation not found", 404);
    const body = await this.request(`/api/sessions/${id}`);
    const parsed = sessionSchema.safeParse(body.session);
    if (!parsed.success || parsed.data.id !== id)
      throw new ConversationError("Conversation not found", 404);
    return parsed.data;
  }

  async create(seed?: string): Promise<{ id: string; existing: boolean }> {
    const id = sessionIdFor(seed || randomUUID());
    let existing = false;
    try {
      await this.request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ id, source: "api_server" }),
      });
    } catch (error) {
      if (!(error instanceof ConversationError) || error.status !== 409) throw error;
      existing = true;
    }
    await this.get(id); // A conflict alone does not prove this is an OpenMuse session.
    await this.index.remember([id]);
    return { id, existing };
  }
}
