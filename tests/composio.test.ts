import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { ComposioService } from "../apps/server/src/composio.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";

const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "sample",
  intelligenceApiKey: "test-project-key-never-sent",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function composio(
  db: Store,
  users: string[],
  execute: () => Promise<{ data?: unknown; error?: string }> = async () => ({ data: { ok: true } }),
) {
  const service = new ComposioService(db, config);
  const session = {
    toolkits: async () => ({
      items: [
        {
          slug: "github",
          name: "GitHub",
          connection: { isActive: true, connectedAccount: { id: "account-1" } },
        },
      ],
    }),
    search: async () => ({ success: true, results: [], toolSchemas: {} }),
    execute,
  };
  Object.assign(service, {
    sdk: {
      sessions: {
        create: async (userId: string) => {
          users.push(userId);
          return { ...session, sessionId: `session-${users.length}` };
        },
        use: () => session,
      },
    },
  });
  return service;
}

test("Composio users are unique across deployments and stable across sessions and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-composio-"));
  const firstUsers: string[] = [];
  let db = await createStore({ dataDir: join(directory, "first-db") });
  try {
    await db.put("local-user", "composio-sessions", { id: "write", sessionId: "legacy-session" });
    await composio(db, firstUsers).toolkits("local-user");
    assert.notEqual(
      (await db.get<{ sessionId: string }>("local-user", "composio-sessions", "write"))?.sessionId,
      "legacy-session",
    );
    await composio(db, firstUsers).search("local-user", "issues", true);
    assert.equal(firstUsers.length, 2);
    assert.equal(firstUsers[0], firstUsers[1]);
    assert.match(firstUsers[0], /^openmuse-[\da-f-]{36}-local-user$/);
    await db.close();
    db = await createStore({ dataDir: join(directory, "first-db") });
    await composio(db, firstUsers).toolkits("other-user");
    assert.equal(firstUsers[2], firstUsers[0].replace(/-local-user$/, "-other-user"));

    const second = await createStore({ dataDir: join(directory, "second-db") });
    try {
      const secondUsers: string[] = [];
      await composio(second, secondUsers).toolkits("local-user");
      assert.notEqual(secondUsers[0], firstUsers[0]);
    } finally {
      await second.close();
    }
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resolved Composio write error stays outcome unknown and cannot dispatch again", async () => {
  const db = await createStore();
  try {
    let calls = 0;
    const sdk = composio(db, [], async () => {
      calls++;
      return { error: "provider reported an error after dispatch" };
    });
    const service = new ActionService(db, {
      connected: async () => true,
      execute: async () => "unused",
      composio: {
        connection: (owner, input) => sdk.connection(owner, input),
        execute: (owner, input, connectionId) => sdk.execute(owner, input, connectionId),
      },
    });
    const proposal = await service.propose("owner", {
      kind: "composio.execute",
      data: { toolkit: "github", tool: "GITHUB_CREATE_ISSUE", args: { title: "Fix bug" } },
    });
    const result = await service.decide("owner", proposal.id, proposal.hash, "approve");
    assert.equal(result.status, "outcome_unknown");
    assert.match(result.error ?? "", /may have completed/);
    assert.doesNotMatch(result.error ?? "", /provider reported/);
    assert.equal(
      (await service.decide("owner", proposal.id, proposal.hash, "approve")).status,
      "outcome_unknown",
    );
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test("an AgentTask with an uncertain linked action pauses until reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-uncertain-task-"));
  const db = await createStore();
  const server = await createApp(db, { ...config, dataDir: directory });
  try {
    const task: AgentTask = {
      id: "task-1",
      title: "Send the reply",
      prompt: "Send the reply",
      kind: "document",
      status: "waiting_approval",
      actionId: "action-1",
      plan: [],
      evidence: [],
      input: {},
      state: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    const action: ActionProposal = {
      id: "action-1",
      taskId: task.id,
      title: "Send reply",
      kind: "email.send",
      data: {},
      status: "outcome_unknown",
      hash: "hash",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      error: "Provider did not confirm delivery",
    };
    await db.put("owner", "tasks", task);
    await db.put("owner", "actions", action);
    await server.agent.worker.tick();
    const paused = await server.agent.getTask("owner", task.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.actionId, action.id);
    assert.match(paused.error ?? "", /outcome unknown/i);
    assert.match(paused.error ?? "", /linked action/i);
    assert.equal(paused.state.notice && typeof paused.state.notice, "object");
    assert.equal(
      (await db.list<{ title: string }>("owner", "notifications"))[0]?.title,
      "Action needs reconciliation",
    );
    await assert.rejects(server.agent.control("owner", task.id, "resume"), /outcome is unknown/i);
    await assert.rejects(server.agent.control("owner", task.id, "retry"), /outcome is unknown/i);
    await assert.rejects(server.agent.control("owner", task.id, "cancel"), /outcome is unknown/i);
    await server.agent.worker.tick();
    assert.equal((await server.agent.getTask("owner", task.id)).attempts, paused.attempts);

    await server.actions.reconcile(
      "owner",
      action.id,
      action.hash,
      "completed",
      "Checked the connected app for delivery",
    );
    assert.equal((await server.agent.getTask("owner", task.id)).error, null);
    await server.agent.control("owner", task.id, "resume");
    await server.agent.worker.tick();
    assert.equal((await server.agent.getTask("owner", task.id)).status, "succeeded");
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const outcome of ["completed", "not_completed"] as const)
  test(`reconciliation ${outcome} during worker pause checkpoint repairs the linked task`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "openmuse-reconcile-race-"));
    const db = await createStore();
    const server = await createApp(db, { ...config, dataDir: directory });
    const now = new Date().toISOString();
    const owner = `reconcile-race-${outcome}`;
    const actionId = `action-${outcome}`;
    const finishCheckpoint = deferred();
    const task: AgentTask = {
      id: `task-${outcome}`,
      title: "Send reply",
      prompt: "Send reply",
      kind: "document",
      status: "waiting_approval",
      actionId,
      plan: [],
      evidence: [],
      input: {},
      state: {},
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    const action: ActionProposal = {
      id: actionId,
      taskId: task.id,
      title: "Send reply",
      kind: "email.send",
      data: {},
      status: "outcome_unknown",
      hash: "hash",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      error: "Provider did not confirm delivery",
    };
    try {
      await db.put(owner, "tasks", task);
      await db.put(owner, "actions", action);
      const beforeCheckpoint = deferred();
      const originalCas = db.compareAndSwap.bind(db);
      let intercept = true;
      t.mock.method(db, "compareAndSwap", async (...args: Parameters<Store["compareAndSwap"]>) => {
        if (
          intercept &&
          args[1] === "tasks" &&
          args[2] === task.id &&
          args[4].status === "paused"
        ) {
          intercept = false;
          beforeCheckpoint.resolve();
          await finishCheckpoint.promise;
        }
        return originalCas(...args);
      });
      const run = server.agent.worker.tick();
      await beforeCheckpoint.promise;
      const resolved = await server.actions.reconcile(
        owner,
        action.id,
        action.hash,
        outcome,
        "Checked connected app records",
      );
      assert.equal((await server.agent.getTask(owner, task.id)).status, "running");
      finishCheckpoint.resolve();
      await run;
      const settled = await server.agent.getTask(owner, task.id);
      assert.equal(resolved.status, outcome === "completed" ? "succeeded" : "failed");
      assert.equal(settled.status, outcome === "completed" ? "paused" : "failed");
      assert.equal(settled.state.notice, null);
      assert.equal(settled.error, outcome === "completed" ? null : resolved.error);
    } finally {
      finishCheckpoint.resolve();
      await server.agent.stop();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
