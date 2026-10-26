/**
 * The upstream seam. The bridge owns translation, not transport: everything Hermes-specific
 * lives behind this interface so the streamed chat turn can later be replaced by the durable
 * runs API without touching the HTTP boundary.
 */

export interface UpstreamRun {
  /** OpenMuse conversation id. The bridge maps it to a Hermes session, never the reverse. */
  threadId: string;
  runId: string;
  /** The user's text for this turn. */
  text: string;
}

export type UpstreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; preview: string; failed: boolean }
  | { type: "error"; message: string }
  | { type: "done" };

export interface UpstreamAgent {
  /** Liveness of the upstream API server, separate from the bridge's own liveness. */
  probe(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }>;
  /** One turn. Yields incrementally; the caller owns cancellation. */
  run(input: UpstreamRun, signal: AbortSignal): AsyncIterable<UpstreamEvent>;
}
