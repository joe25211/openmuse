import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  type DelegatedPane,
  delegatedTaskStatus,
  paneAfterHorizontalGesture,
} from "../src/delegated-chat.ts";

test("horizontal gestures switch panes without consuming vertical or short movement", () => {
  const current: DelegatedPane = "chat";
  assert.equal(paneAfterHorizontalGesture(-60, 5, current), "task");
  assert.equal(paneAfterHorizontalGesture(60, 5, "task"), "chat");
  assert.equal(paneAfterHorizontalGesture(20, 5, current), "chat");
  assert.equal(paneAfterHorizontalGesture(-60, 80, current), "chat");
});

test("delegated status stays explicit for uncertain and waiting outcomes", () => {
  const status = (value: AgentTask["status"], delegation?: AgentTask["delegation"]) =>
    delegatedTaskStatus({ status: value, delegation });
  assert.equal(status("outcome_unknown"), "Outcome unknown");
  assert.equal(status("waiting_input"), "Needs your input");
  assert.equal(status("succeeded"), "Completed");
  assert.equal(status("failed"), "Failed");
  const delayedDelegation = { ...context, delayedAt: "2026-09-28T00:00:00Z" };
  assert.equal(status("running", delayedDelegation), "Taking longer than usual");
});

const context: NonNullable<AgentTask["delegation"]> = {
  conversationId: "conversation",
  requestId: "request",
  botId: "bot",
  botName: "Scout",
  sentContext: "Task: Find a plan",
  runId: "run",
  channelAttempted: true,
  submissionAttempted: true,
};
