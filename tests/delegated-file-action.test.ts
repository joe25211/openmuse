import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore } from "../apps/server/src/db.ts";
import { delegatedFileProposal } from "../apps/server/src/engine/delegated-action.ts";
import {
  executeLocalAction,
  localActionEvidence,
  textHash,
} from "../apps/server/src/local-action.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ProposalInput } from "../packages/domain/src/index.ts";

const owner = "file-owner";
const path = `${createHash("sha256").update(owner).digest("hex").slice(0, 24)}/notes.txt`;
const oldText = "First line\n";
const newText = "Reviewed replacement\n";
const input: ProposalInput = {
  kind: "file.replace_text",
  data: {
    path,
    expectedSha256: textHash(oldText),
    replacementText: newText,
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openmuse-reviewed-file-"));
  await mkdir(join(root, path.split("/")[0]));
  const target = join(root, path);
  await writeFile(target, oldText);
  const db = await createStore();
  const actions = new ActionService(db, {
    connected: async () => false,
    execute: async () => {
      throw new Error("Workspace execution must not be used");
    },
    scopedReadRoot: root,
  });
  const task: AgentTask = {
    id: "task-1",
    title: "Replace notes",
    prompt: "Replace the text in the named file",
    kind: "openbot",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 1,
    artifactIds: [],
    delegation: {
      conversationId: "conversation",
      requestId: "request",
      botId: "bot",
      botName: "Bot",
      sentContext: "",
      sourcePath: "notes.txt",
      resourcePath: path,
      readMode: "direct",
      runId: "run-1",
      channelAttempted: true,
      submissionAttempted: true,
    },
  };
  await db.put(owner, "tasks", task);
  return {
    root,
    target,
    db,
    actions,
    task,
    close: async () => {
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("terminal Bot block is exact, bound to its resource, and draft-only remains text", () => {
  const delegation = {
    conversationId: "conversation",
    requestId: "request",
    botId: "bot",
    botName: "Bot",
    sentContext: "",
    sourcePath: "notes.txt",
    resourcePath: path,
    readMode: "direct" as const,
    runId: "run-1",
    channelAttempted: true,
    submissionAttempted: true,
  };
  const block = `Answer\n\x60\x60\x60openmuse-action\n${JSON.stringify({
    kind: "file.replace_text",
    target: "named-resource",
    resourceId: textHash(path).slice(0, 16),
    expectedText: oldText,
    replacementText: newText,
  })}\n\x60\x60\x60`;
  assert.deepEqual(delegatedFileProposal(block, "Replace the named file", delegation), input);
  assert.equal(
    delegatedFileProposal(block, "Draft a replacement for the named file", delegation),
    null,
  );
  assert.equal(
    delegatedFileProposal(`${block}\nMore prose`, "Replace the named file", delegation),
    null,
  );
  assert.equal(
    delegatedFileProposal(
      block.replace('"target":"named-resource"', '"target":"elsewhere"'),
      "Replace the named file",
      delegation,
    ),
    null,
  );
  assert.equal(
    delegatedFileProposal(
      block.replace('"replacementText":', '"extra":true,"replacementText":'),
      "Replace the named file",
      delegation,
    ),
    null,
  );
  assert.equal(
    delegatedFileProposal(block, "Replace the named file", { ...delegation, readMode: "excerpt" }),
    null,
  );
});

test("durable review denies without mutation and concurrent approval executes exact replacement once", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.actions.propose(owner, input), /linked/i);
    const denied = await f.actions.propose(owner, input, "denied", f.task.id);
    assert.equal(await readFile(f.target, "utf8"), oldText);
    assert.equal((await f.actions.decide(owner, denied.id, denied.hash, "deny")).status, "denied");
    assert.equal(await readFile(f.target, "utf8"), oldText);
    const proposed = await f.actions.propose(owner, input, "approved", f.task.id);
    await f.db.put(owner, "tasks", { ...f.task, status: "succeeded", actionId: proposed.id });
    const decisions = await Promise.all([
      f.actions.decide(owner, proposed.id, proposed.hash, "approve"),
      f.actions.decide(owner, proposed.id, proposed.hash, "approve"),
    ]);
    assert(decisions.some((item) => item.status === "succeeded"));
    assert.equal(
      (await f.db.get<{ status: string }>(owner, "actions", proposed.id))?.status,
      "succeeded",
    );
    assert.equal(await readFile(f.target, "utf8"), newText);
    assert.equal(
      (await f.actions.decide(owner, proposed.id, proposed.hash, "approve")).status,
      "succeeded",
    );
  } finally {
    await f.close();
  }
});

test("changed source, tampered review and superseded run cannot execute", async () => {
  const f = await fixture();
  try {
    const changed = await f.actions.propose(owner, input, "changed", f.task.id);
    await f.db.put(owner, "tasks", { ...f.task, status: "succeeded", actionId: changed.id });
    await writeFile(f.target, "Someone else's edit\n");
    assert.equal(
      (await f.actions.decide(owner, changed.id, changed.hash, "approve")).status,
      "failed",
    );
    assert.equal(await readFile(f.target, "utf8"), "Someone else's edit\n");
    await writeFile(f.target, oldText);
    await f.db.put(owner, "tasks", f.task);
    const tampered = await f.actions.propose(owner, input, "tampered", f.task.id);
    await f.db.compareAndSwap(
      owner,
      "actions",
      tampered.id,
      { hash: tampered.hash },
      { data: { ...tampered.data, replacementText: "Injected" } },
    );
    await f.db.put(owner, "tasks", { ...f.task, status: "succeeded", actionId: tampered.id });
    await assert.rejects(
      f.actions.decide(owner, tampered.id, tampered.hash, "approve"),
      /changed/i,
    );
    await f.db.put(owner, "tasks", f.task);
    const superseded = await f.actions.propose(owner, input, "superseded", f.task.id);
    await f.db.put(owner, "tasks", { ...f.task, status: "succeeded", actionId: superseded.id });
    await f.db.put(owner, "delegated-retries", { id: f.task.id, taskId: "new-attempt" });
    await assert.rejects(
      f.actions.decide(owner, superseded.id, superseded.hash, "approve"),
      /attempt changed/i,
    );
    await f.db.put(owner, "tasks", f.task);
    await assert.rejects(
      f.actions.propose(owner, input, "late-original", f.task.id),
      /superseded/i,
    );
    assert.equal(await readFile(f.target, "utf8"), oldText);
  } finally {
    await f.close();
  }
});

test("pinned directory rejects symlinks and final content recheck preserves an in-place edit", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      executeLocalAction(f.root, { ...input, data: { ...input.data, path: "../notes.txt" } }),
      /scoped/i,
    );
    await symlink(f.target, join(f.root, path.split("/")[0], "link.txt"));
    await assert.rejects(
      executeLocalAction(f.root, {
        ...input,
        data: { ...input.data, path: `${path.split("/")[0]}/link.txt` },
      }),
      /safe|scoped/i,
    );
    await assert.rejects(
      executeLocalAction(f.root, input, async () => {
        await writeFile(f.target, "Concurrent edit\n");
      }),
      /changed/i,
    );
    assert.equal(await readFile(f.target, "utf8"), "Concurrent edit\n");
    assert.equal(await localActionEvidence(f.root, input), "unknown");
    await writeFile(f.target, newText);
    assert.equal(await localActionEvidence(f.root, input), "completed");
    await writeFile(f.target, oldText);
    assert.equal(await localActionEvidence(f.root, input), "not_completed");
  } finally {
    await f.close();
  }
});

test("interrupted local write settles only from exact before or after content", async () => {
  const f = await fixture();
  try {
    const proposal = await f.actions.propose(owner, input, "interrupted", f.task.id);
    await f.db.put(owner, "tasks", { ...f.task, status: "succeeded", actionId: proposal.id });
    await f.db.compareAndSwap(
      owner,
      "actions",
      proposal.id,
      { status: "awaiting_review" },
      { status: "executing" },
    );
    await f.db.recoverInterruptedActions();
    assert.equal(
      (await f.db.get<{ status: string }>(owner, "actions", proposal.id))?.status,
      "outcome_unknown",
    );
    await writeFile(f.target, "Third version\n");
    assert.equal(
      (await f.actions.reconcileLocalFile(owner, proposal.id)).status,
      "outcome_unknown",
    );
    await assert.rejects(
      f.actions.reconcile(
        owner,
        proposal.id,
        proposal.hash,
        "not_completed",
        "Looked at the local file",
      ),
      /exact file evidence/i,
    );
    await writeFile(f.target, newText);
    assert.equal((await f.actions.reconcileLocalFile(owner, proposal.id)).status, "succeeded");
    assert.equal(await readFile(f.target, "utf8"), newText);
    assert.equal(
      (await f.actions.decide(owner, proposal.id, proposal.hash, "approve")).status,
      "succeeded",
    );
  } finally {
    await f.close();
  }
});

test("two distinct approved actions for one source allow exactly one replacement", async () => {
  const f = await fixture();
  try {
    const secondTask = {
      ...f.task,
      id: "task-2",
      delegation: {
        ...f.task.delegation,
        runId: "run-2",
        requestId: "request-2",
      },
    };
    await f.db.put(owner, "tasks", secondTask);
    const first = await f.actions.propose(owner, input, "first-file-action", f.task.id);
    const second = await f.actions.propose(owner, input, "second-file-action", secondTask.id);
    await f.db.put(owner, "tasks", { ...f.task, status: "succeeded", actionId: first.id });
    await f.db.put(owner, "tasks", { ...secondTask, status: "succeeded", actionId: second.id });
    const results = await Promise.all([
      f.actions.decide(owner, first.id, first.hash, "approve"),
      f.actions.decide(owner, second.id, second.hash, "approve"),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["failed", "succeeded"]);
    assert.equal(await readFile(f.target, "utf8"), newText);
    assert(
      ["failed", "succeeded"].includes(
        (await f.db.get<{ status: string }>(owner, "local-file-claims", textHash(path)))?.status ??
          "",
      ),
    );
  } finally {
    await f.close();
  }
});
