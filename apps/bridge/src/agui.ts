/**
 * AG-UI event builders. One place decides the wire shape, so the translator never
 * hand-writes event objects and a schema change has a single edit site.
 */

import { EventType } from "@ag-ui/core";

export function runStarted(threadId: string, runId: string) {
  return { type: EventType.RUN_STARTED, threadId, runId } as const;
}

export function textMessageStart(messageId: string) {
  return { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as const;
}

export function textMessageContent(messageId: string, delta: string) {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta } as const;
}

export function textMessageEnd(messageId: string) {
  return { type: EventType.TEXT_MESSAGE_END, messageId } as const;
}

export function runFinished(threadId: string, runId: string) {
  return { type: EventType.RUN_FINISHED, threadId, runId } as const;
}

export function runError(message: string) {
  return { type: EventType.RUN_ERROR, message } as const;
}
