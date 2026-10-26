import { createHash } from "node:crypto";

/** Canonical IDs are handles, not authorization; callers must verify registry ownership. */
export function sessionIdFor(threadId: string): string {
  return /^om_[a-f0-9]{32}$/.test(threadId)
    ? threadId
    : `om_${createHash("sha256").update(threadId).digest("hex").slice(0, 32)}`;
}
