import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import type { ProposalInput } from "../../../packages/domain/src/index.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

type ComposioAction = Extract<ProposalInput, { kind: "composio.execute" }>;
type SessionKind = "read" | "write";
const utilityToolkits = new Set(["composio", "composio_search"]);
const uncertainWrite = () =>
  Object.assign(
    new Error(
      "Composio may have completed this action. Check the connected app before trying again.",
    ),
    { outcomeUnknown: true },
  );

export class ComposioService {
  private readonly sdk?: Composio;

  constructor(
    private readonly db: Store,
    config: Config,
  ) {
    if (config.composioApiKey)
      this.sdk = new Composio({ apiKey: config.composioApiKey, allowTracking: false });
  }

  get configured() {
    return Boolean(this.sdk);
  }

  private client() {
    if (!this.sdk) throw new AppError("Set COMPOSIO_API_KEY on the server first", 503);
    return this.sdk;
  }

  private async session(owner: string, kind: SessionKind) {
    const sdk = this.client();
    const deployment =
      (await this.db.insertIfAbsent("system", "composio-settings", {
        id: "deployment",
        namespace: randomUUID(),
      })) ??
      (await this.db.get<{ namespace: string }>("system", "composio-settings", "deployment"));
    if (!deployment) throw new AppError("Composio deployment could not be loaded", 503);
    const userId = `openmuse-${deployment.namespace}-${owner}`;
    const saved = await this.db.get<{ id: string; sessionId: string; userId?: string }>(
      owner,
      "composio-sessions",
      kind,
    );
    if (saved?.userId === userId) return sdk.sessions.use(saved.sessionId);
    // Pre-namespace sessions cannot prove deployment ownership; reconnect their accounts.
    const created = await sdk.sessions.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
      ...(kind === "read" ? { tags: ["readOnlyHint"] } : {}),
    });
    const stored = saved
      ? await this.db.compareAndSwap(
          owner,
          "composio-sessions",
          kind,
          { sessionId: saved.sessionId },
          {
            sessionId: created.sessionId,
            userId,
          },
        )
      : await this.db.insertIfAbsent(owner, "composio-sessions", {
          id: kind,
          sessionId: created.sessionId,
          userId,
        });
    if (stored) return created;
    const winner = await this.db.get<{ sessionId: string; userId?: string }>(
      owner,
      "composio-sessions",
      kind,
    );
    if (!winner || winner.userId !== userId)
      throw new AppError("Composio session could not be loaded", 503);
    return sdk.sessions.use(winner.sessionId);
  }

  async toolkits(owner: string, search = "", cursor?: string) {
    const result = await (await this.session(owner, "write")).toolkits({
      search,
      cursor,
      limit: 30,
    });
    return {
      items: result.items
        .filter(({ slug }) => !utilityToolkits.has(slug))
        .map(({ slug, name, connection }) => ({
          slug,
          name,
          connected: connection?.isActive === true,
          accountId: connection?.connectedAccount?.id,
        })),
      cursor: result.cursor,
    };
  }

  async authorize(owner: string, toolkit: string) {
    if (utilityToolkits.has(toolkit))
      throw new AppError(
        "Choose a specific app to connect; Composio utility tools cannot be connected.",
        400,
      );
    const session = await this.session(owner, "write");
    const status = await session.toolkits({ toolkits: [toolkit], limit: 1 });
    if (!status.items.some((item) => item.slug === toolkit))
      throw new AppError("Composio app was not found", 404);
    if (status.items[0]?.connection?.isActive) return { connected: true, url: null };
    const link = await session.authorize(toolkit);
    return { connected: false, url: link.redirectUrl };
  }

  async search(owner: string, query: string, readOnly: boolean) {
    const result = await (await this.session(owner, readOnly ? "read" : "write")).search({
      query,
    });
    if (!result.success) throw new AppError(result.error ?? "Composio search failed", 502);
    const slugs = [...new Set(result.results.flatMap((item) => item.primaryToolSlugs))].slice(
      0,
      10,
    );
    return {
      tools: slugs.map((slug) => ({
        slug,
        toolkit: result.toolSchemas[slug]?.toolkit,
        description: result.toolSchemas[slug]?.description,
        inputSchema: result.toolSchemas[slug]?.inputSchema,
      })),
      readOnly,
    };
  }

  async read(owner: string, tool: string, args: Record<string, unknown>) {
    this.assertAppTool(tool);
    const result = await (await this.session(owner, "read")).execute(tool, args);
    if (result.error) throw new AppError(result.error, 502);
    const encoded = JSON.stringify(result.data);
    return {
      data: encoded.length > 30000 ? encoded.slice(0, 30000) : result.data,
      truncated: encoded.length > 30000,
      logId: result.logId,
    };
  }

  async connection(owner: string, input: ComposioAction) {
    this.assertAppTool(input.data.tool, input.data.toolkit);
    const result = await (await this.session(owner, "write")).toolkits({
      toolkits: [input.data.toolkit],
      isConnected: true,
      limit: 1,
    });
    const item = result.items.find((value) => value.slug === input.data.toolkit);
    const id = item?.connection?.connectedAccount?.id;
    if (!item?.connection?.isActive || !id)
      throw new AppError(
        `Connect ${input.data.toolkit} in Composio before preparing this action`,
        409,
      );
    return { id, account: `${item.name} · ${id}` };
  }

  async execute(owner: string, input: ComposioAction, connectionId?: string) {
    const current = await this.connection(owner, input);
    if (current.id !== connectionId)
      throw new AppError("Composio account changed. Prepare a new action.", 409);
    const session = await this.session(owner, "write");
    const result = await session
      .execute(input.data.tool, input.data.args, { account: connectionId })
      .catch(() => {
        throw uncertainWrite();
      });
    if (result.error) throw uncertainWrite();
    try {
      const data = result.data ?? null;
      const encoded = JSON.stringify(data);
      return JSON.stringify({
        data: encoded.length > 30000 ? encoded.slice(0, 30000) : data,
        truncated: encoded.length > 30000,
        logId: result.logId,
      });
    } catch {
      throw uncertainWrite();
    }
  }

  private assertAppTool(tool: string, toolkit?: string) {
    if (!/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(tool) || tool.startsWith("COMPOSIO_"))
      throw new AppError("Choose one Composio app tool, not a meta-tool", 422);
    if (toolkit && !tool.startsWith(`${toolkit.toUpperCase()}_`))
      throw new AppError("Tool does not belong to the selected Composio app", 422);
  }
}
