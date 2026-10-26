/**
 * Bridge configuration. Every downstream URL and credential is read here and nowhere else:
 * a request may describe a conversation, never where Hermes lives.
 */

export interface BridgeConfig {
  host: string;
  port: number;
  /** Absolute base URL of the Hermes API server, without a trailing slash. */
  hermesBaseUrl: string;
  hermesApiKey: string;
  /** Bearer token the OpenMuse server presents. Distinct from the Hermes key. */
  bridgeToken: string;
  /** Stores only known conversation IDs, not messages or credentials. */
  dataDir: string;
}

type Env = Record<string, string | undefined>;

const MIN_TOKEN_LENGTH = 16;

function parseBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("HERMES_BASE_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("HERMES_BASE_URL must be an absolute http(s) URL");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function bridgeConfig(env: Env = process.env): BridgeConfig {
  const bridgeToken = (env.BRIDGE_TOKEN ?? "").trim();
  if (bridgeToken.length < MIN_TOKEN_LENGTH)
    throw new Error(`BRIDGE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const hermesApiKey = (env.HERMES_API_KEY ?? "").trim();
  if (!hermesApiKey) throw new Error("HERMES_API_KEY is required");
  const hermesBaseUrl = parseBaseUrl((env.HERMES_BASE_URL ?? "http://127.0.0.1:8642").trim());
  const port = Number(env.BRIDGE_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("BRIDGE_PORT must be an integer from 1 to 65535");
  return {
    host: env.BRIDGE_HOST ?? "127.0.0.1",
    port,
    hermesBaseUrl,
    hermesApiKey,
    bridgeToken,
    dataDir: env.BRIDGE_DATA_DIR || ".openmuse/bridge",
  };
}
