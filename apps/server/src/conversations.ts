import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

/** Fixed bridge contract only; no Hermes protocol or client-selected target. */
export class Conversations {
  constructor(
    private config: Config,
    private fetchBridge: typeof fetch = fetch,
  ) {}

  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (this.config.agentBackend !== "agui")
      throw new AppError("Conversations require the AG-UI bridge", 503);
    let endpoint: URL;
    try {
      endpoint = new URL(this.config.agentUrl ?? "");
      if (
        !/^https?:$/.test(endpoint.protocol) ||
        !endpoint.pathname.endsWith("/run") ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error("Invalid bridge endpoint");
    } catch {
      throw new AppError("Configure AGENT_URL ending in /run for conversations", 503);
    }
    if (!this.config.agentToken?.trim())
      throw new AppError("Configure AGENT_TOKEN for conversations", 503);
    endpoint.pathname = endpoint.pathname.slice(0, -4) + path.split("?")[0];
    endpoint.search = path.includes("?") ? path.slice(path.indexOf("?")) : "";
    try {
      const response = await this.fetchBridge(endpoint.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.agentToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (response.status === 404) throw new AppError("Conversation not found", 404);
        throw new AppError("Conversation bridge request failed", 502);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("Conversation bridge is unavailable", 502);
    }
  }
}
