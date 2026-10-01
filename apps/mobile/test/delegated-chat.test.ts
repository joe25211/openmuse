import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  type DelegatedPane,
  delegatedTaskNotice,
  delegatedTaskStatus,
  freshestTask,
  paneAfterHorizontalGesture,
  taskForConversation,
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
  assert.equal(status("outcome_unknown", { ...context, stop: "unconfirmed" }), "Stop unconfirmed");
  assert.equal(status("succeeded", { ...context, stop: "unconfirmed" }), "Completed");
  const delayedDelegation = { ...context, delayedAt: "2026-09-28T00:00:00Z" };
  assert.equal(status("running", delayedDelegation), "Taking longer than usual");
});

test("handoff notices describe stop state and keep a later terminal outcome", () => {
  const notice = (status: AgentTask["status"], delegation = context) =>
    delegatedTaskNotice({ status, delegation });
  assert.equal(
    notice("cancelled", { ...context, stop: "confirmed" }),
    "Bot stop confirmed. Started external changes may remain.",
  );
  assert.equal(
    notice("cancelled", { ...context, submissionAttempted: false, stop: "confirmed" }),
    "Cancelled before Bot submission.",
  );
  assert.equal(
    notice("outcome_unknown", { ...context, stop: "unconfirmed" }),
    "Stop unconfirmed. OpenMuse is checking the original Bot run.",
  );
  assert.equal(
    notice("succeeded", { ...context, stop: "unconfirmed" }),
    "Scout finished. The saved result is in Task.",
  );
  assert.equal(notice("failed", { ...context, stop: "unconfirmed" }), "Scout reported a failure.");
});

test("delegated task lookup uses the effective local conversation id", () => {
  const local = delegatedTask("local-task", "local", "2026-09-28T01:00:00Z");
  const localMain = delegatedTask("main-task", "local-main", "2026-09-28T00:00:00Z");
  assert.equal(taskForConversation([local, localMain], "local-main"), localMain);
  assert.equal(taskForConversation([local, localMain], "local"), local);
});

test("task pane prefers the newest matching task and ignores details for another task", () => {
  const workspaceTask = delegatedTask("task", "conversation", "2026-09-28T01:00:00Z");
  const staleDetail = {
    ...workspaceTask,
    status: "running" as const,
    updatedAt: "2026-09-28T00:00:00Z",
  };
  const freshDetail = {
    ...workspaceTask,
    status: "succeeded" as const,
    updatedAt: "2026-09-28T02:00:00Z",
  };
  assert.equal(freshestTask(workspaceTask, staleDetail), workspaceTask);
  assert.equal(freshestTask(workspaceTask, freshDetail), freshDetail);
  assert.equal(freshestTask(workspaceTask, { ...freshDetail, id: "other" }), workspaceTask);
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

function delegatedTask(id: string, conversationId: string, createdAt: string): AgentTask {
  return {
    id,
    title: "Task",
    prompt: "Task prompt",
    kind: "openbot",
    delegation: { ...context, conversationId },
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt,
    updatedAt: createdAt,
    attempts: 1,
    artifactIds: [],
  };
}
