import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-delegation-"));
  let tools: unknown[] = [];
  let channelCalls = 0;
  const bot = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const path = request.url;
    if (path === "/api/agents")
      response.end(
        JSON.stringify({ agents: [{ id: "bot-1", name: "Notes Bot", endpoint: null }] }),
      );
    else if (path === "/api/plugins/for/bot-1") response.end(JSON.stringify({ tools, skills: [] }));
    else if (path === "/api/host-access")
      response.end(JSON.stringify({ grants: [], pending: [], connected: false }));
    else if (path === "/api/channels") {
      channelCalls++;
      response.end(
        JSON.stringify({ channel: { id: "channel-1", threadId: "thread-1", agentIds: ["bot-1"] } }),
      );
    } else response.writeHead(404).end("{}");
  });
  bot.listen(0, "127.0.0.1");
  await once(bot, "listening");
  const address = bot.address();
  assert(address && typeof address !== "string");
  let db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://127.0.0.1:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-only",
    googleRedirectUri: "http://127.0.0.1:8787/api/google/callback",
    allowedOrigins: [],
    openbotEnabled: true,
    openbotBaseUrl: `http://127.0.0.1:${address.port}`,
  };
  let server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  const token = (await session.json()).token as string;
  const owner = await server.auth.owner(`Bearer ${token}`);
  await db.put(owner, "conversation-settings", { id: "main", threadId: "conversation-1" });
  const request = (conversationId: string, body: unknown, authorized = true) =>
    server.app.request(`/api/conversations/${conversationId}/delegations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    get server() {
      return server;
    },
    get db() {
      return db;
    },
    owner,
    token,
    request,
    setTools(value: unknown[]) {
      tools = value;
    },
    get channelCalls() {
      return channelCalls;
    },
    async restart() {
      await server.agent.stop();
      await db.close();
      db = await createStore({ dataDir: join(directory, "db") });
      server = await createApp(db, config);
    },
    async close() {
      await server.agent.stop();
      await db.close();
      bot.close();
      await once(bot, "close");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("authenticated named Bot task persists its attempt before dispatch and reloads the answer", async (t) => {
  const f = await fixture();
  try {
    const gateway = f.server.agent.openbot;
    assert(gateway);
    const intelligence = f.server.agent.intelligence;
    assert(intelligence);
    t.mock.method(intelligence, "listThreads", async () => ({ threads: [], joinCode: "test" }));
    const input = {
      requestId: "request-1",
      botId: "Notes Bot",
      prompt: "Summarize this text",
      brief: "It is about a garden.",
    };
    assert.equal((await f.request("conversation-1", input, false)).status, 401);
    assert.equal((await f.request("another-conversation", input)).status, 404);
    const response = await f.request("conversation-1", input);
    assert.equal(response.status, 201, await response.clone().text());
    const created = (await response.json()) as AgentTask;
    assert.equal(created.kind, "openbot");
    assert.equal((await f.request("conversation-1", input)).status, 201);
    assert.equal(
      (await f.request("conversation-1", { ...input, prompt: "Different" })).status,
      409,
    );
    const run = t.mock.method(
      gateway,
      "runText",
      async (
        botId: string,
        threadId: string,
        runId: string,
        text: string,
        onStartup: () => Promise<void>,
      ) => {
        const before = await f.db.get<AgentTask>(f.owner, "tasks", created.id);
        assert.equal(before?.delegation?.submissionAttempted, true);
        assert.equal(before?.delegation?.channelId, "channel-1");
        assert.equal(before?.delegation?.threadId, threadId);
        assert.equal(before?.delegation?.runId, runId);
        assert.equal(botId, "bot-1");
        assert.equal(text, "Task: Summarize this text\nRelevant brief: It is about a garden.");
        await onStartup();
        return { terminal: "finished" as const, messageIds: ["answer-1"] };
      },
    );
    t.mock.method(gateway, "textResult", async () => "A garden summary.");
    await f.server.agent.worker.tick();
    assert.equal(run.mock.callCount(), 1);
    assert.equal(f.channelCalls, 1);
    const detail = await f.server.app.request(`/api/agent/tasks/${created.id}`, {
      headers: { Authorization: `Bearer ${f.token}` },
    });
    assert.equal(detail.status, 200);
    const saved = (await detail.json()).task as AgentTask;
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.result, "A garden summary.");
    assert.equal(saved.delegation?.terminal, "finished");
    assert.deepEqual(saved.delegation?.messageIds, ["answer-1"]);
    assert.equal(saved.delegation?.output, "A garden summary.");
  } finally {
    await f.close();
  }
});

test("side and local conversations require an owner-scoped conversation", async (t) => {
  const f = await fixture();
  try {
    const intelligence = f.server.agent.intelligence;
    assert(intelligence);
    const listed = t.mock.method(
      intelligence,
      "listThreads",
      async ({ userId, agentId, cursor }: { userId: string; agentId: string; cursor?: string }) => {
        assert.equal(userId, f.owner);
        assert.equal(agentId, "default");
        return cursor
          ? {
              threads: [{ id: "side-1", agentId: "default", createdById: f.owner }],
              joinCode: "test",
            }
          : { threads: [], joinCode: "test", nextCursor: "page-2" };
      },
    );
    const input = { requestId: "side-request", botId: "bot-1", prompt: "Summarize notes" };
    assert.equal((await f.request("side-1", input)).status, 201);
    assert.equal((await f.request("foreign-side", input)).status, 404);
    assert.equal(listed.mock.callCount(), 4);
    assert.equal(await f.db.get(f.owner, "conversations", "default"), null);
    const firstTurn = await f.request("local-main", input);
    assert.equal(firstTurn.status, 201);
    assert.equal(((await firstTurn.json()) as AgentTask).delegation?.conversationId, "local-main");
    assert.equal(await f.db.get(f.owner, "conversations", "default"), null);
    assert.equal(listed.mock.callCount(), 4);
    assert.equal((await f.request("local", input)).status, 404);
    await f.db.put(f.owner, "conversations", { id: "default", messages: [] });
    assert.equal((await f.request("local", input)).status, 201);
  } finally {
    await f.close();
  }
});

test("the first task insert is fully delegated even if the response is lost", async (t) => {
  const f = await fixture();
  try {
    const original = f.db.insertIfAbsent.bind(f.db);
    let interrupted = false;
    t.mock.method(
      f.db,
      "insertIfAbsent",
      async (owner: string, collection: string, value: { id: string }) => {
        const result = await original(owner, collection, value);
        if (collection === "tasks" && !interrupted) {
          interrupted = true;
          const saved = value as AgentTask;
          assert.equal(saved.kind, "openbot");
          assert.equal(saved.status, "queued");
          assert.equal(saved.delegation?.submissionAttempted, false);
          throw new Error("response lost after insert");
        }
        return result;
      },
    );
    const input = { requestId: "insert-crash", botId: "bot-1", prompt: "One answer" };
    assert.equal((await f.request("conversation-1", input)).status, 502);
    const [first, duplicate] = await Promise.all([
      f.request("conversation-1", input),
      f.request("conversation-1", input),
    ]);
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 201);
    const task = (await first.json()) as AgentTask;
    assert.equal(((await duplicate.json()) as AgentTask).delegation?.runId, task.delegation?.runId);
    assert.equal((await f.db.list<AgentTask>(f.owner, "tasks")).length, 1);
    const concurrent = { ...input, requestId: "concurrent-insert" };
    const [a, b] = await Promise.all([
      f.request("conversation-1", concurrent),
      f.request("conversation-1", concurrent),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(((await a.json()) as AgentTask).id, ((await b.json()) as AgentTask).id);
    assert.equal((await f.db.list<AgentTask>(f.owner, "tasks")).length, 2);
  } finally {
    await f.close();
  }
});

test("overprivileged Bot is refused and uncertain submission is never resent", async (t) => {
  const f = await fixture();
  try {
    const gateway = f.server.agent.openbot;
    assert(gateway);
    const input = { requestId: "request-2", botId: "bot-1", prompt: "Answer in plain text" };
    f.setTools([{ ref: "host/shell" }]);
    assert.equal((await f.request("conversation-1", input)).status, 409);
    f.setTools([]);
    const response = await f.request("conversation-1", input);
    assert.equal(response.status, 201);
    const task = (await response.json()) as AgentTask;
    const run = t.mock.method(gateway, "runText", async () => {
      throw new Error("lost response");
    });
    t.mock.method(gateway, "reconnectRun", async () => ({
      terminal: "unconfirmed" as const,
      messageIds: [],
      lost: true,
    }));
    await f.server.agent.worker.tick();
    await f.server.agent.worker.tick();
    assert.equal(run.mock.callCount(), 1);
    assert.equal(f.channelCalls, 1);
    const saved = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(saved?.status, "running");
    assert.equal(saved.delegation?.submissionAttempted, true);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    clock += 5 * 60_000 + 5000;
    await f.server.agent.worker.tick();
    assert.equal((await f.db.get<AgentTask>(f.owner, "tasks", task.id))?.status, "outcome_unknown");
    const transportLostAt = (await f.db.get<AgentTask>(f.owner, "tasks", task.id))?.delegation
      ?.transportLostAt;
    assert(transportLostAt);
    t.mock.method(
      gateway,
      "reconnectRun",
      async (
        _bot: string,
        _thread: string,
        _run: string,
        _cursor: string | undefined,
        onEvent: (event: { type: string; cursor?: string }) => Promise<void>,
      ) => {
        await onEvent({ type: "TEXT_MESSAGE_END", cursor: "old-event" });
        return { terminal: "unconfirmed" as const, messageIds: [] };
      },
    );
    clock += 6000;
    await f.server.agent.worker.tick();
    const replayed = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(replayed?.status, "outcome_unknown");
    assert.equal(replayed.delegation?.transportLostAt, transportLostAt);
    assert.equal(
      (await f.db.list<{ title: string }>(f.owner, "notifications")).filter(
        (n) => n.title === "Outcome unknown",
      ).length,
      1,
    );
    assert.equal(
      (
        await f.server.app.request(`/api/agent/tasks/${task.id}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.token}` },
          body: JSON.stringify({ action: "retry" }),
        })
      ).status,
      409,
    );
    t.mock.method(gateway, "reconnectRun", async () => ({
      terminal: "finished" as const,
      messageIds: ["late-answer"],
    }));
    t.mock.method(gateway, "textResult", async () => "Late verified answer.");
    clock += 6000;
    await f.server.agent.worker.tick();
    const recovered = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(recovered?.status, "succeeded");
    assert.equal(recovered.error, null);
    assert.equal(run.mock.callCount(), 1);
    assert.equal(
      (await f.db.list<{ title: string }>(f.owner, "notifications")).filter(
        (n) => n.title === "Answer in plain text",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("confirmed error and empty answer do not complete a delegated task", async (t) => {
  const f = await fixture();
  try {
    const gateway = f.server.agent.openbot;
    assert(gateway);
    const outcomes: Array<"error" | "finished"> = ["error", "finished"];
    t.mock.method(gateway, "runText", async () => ({
      terminal: outcomes.shift() ?? "unconfirmed",
      messageIds: ["answer-1"],
    }));
    t.mock.method(gateway, "textResult", async () => "");
    for (const requestId of ["error", "empty"]) {
      const response = await f.request("conversation-1", {
        requestId,
        botId: "bot-1",
        prompt: "One text answer",
      });
      assert.equal(response.status, 201);
      const created = (await response.json()) as AgentTask;
      await f.server.agent.worker.tick();
      const saved = await f.db.get<AgentTask>(f.owner, "tasks", created.id);
      assert.equal(saved?.status, "failed");
      assert.equal(saved.result, undefined);
      assert.equal(saved.delegation?.terminal, requestId === "error" ? "error" : "finished");
    }
  } finally {
    await f.close();
  }
});

test("restart recovers the saved run and output without another submission", async (t) => {
  const f = await fixture();
  try {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const response = await f.request("conversation-1", {
      requestId: "restart",
      botId: "bot-1",
      prompt: "One answer",
    });
    const task = (await response.json()) as AgentTask;
    const first = f.server.agent.openbot;
    assert(first);
    const firstRun = t.mock.method(
      first,
      "runText",
      async (
        _bot: string,
        _thread: string,
        _run: string,
        _text: string,
        onStartup: () => Promise<void>,
        _signal: AbortSignal,
        onEvent: (event: { type: string; cursor?: string; messageId?: string }) => Promise<void>,
      ) => {
        await onStartup();
        await onEvent({ type: "RUN_STARTED", cursor: "event-1" });
        await onEvent({ type: "TEXT_MESSAGE_START", cursor: "event-2", messageId: "answer-1" });
        return { terminal: "unconfirmed" as const, messageIds: ["answer-1"], lost: true };
      },
    );
    await f.server.agent.worker.tick();
    assert.equal(firstRun.mock.callCount(), 1);
    const interrupted = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(interrupted?.status, "running");
    assert.equal(interrupted.delegation?.replayCursor, "event-2");
    assert.deepEqual(interrupted.delegation?.messageIds, ["answer-1"]);
    await f.db.compareAndSwap(
      f.owner,
      "tasks",
      task.id,
      { status: "running" },
      {
        leaseId: "expired-worker",
        leaseUntil: new Date(clock - 1000).toISOString(),
      },
    );
    await f.restart();
    const second = f.server.agent.openbot;
    assert(second);
    const repeated = t.mock.method(second, "runText", async () => {
      throw new Error("second submission");
    });
    const connect = t.mock.method(
      second,
      "reconnectRun",
      async (
        _bot: string,
        threadId: string,
        runId: string,
        cursor: string | undefined,
        onEvent: (event: {
          type: string;
          cursor?: string;
          terminal?: "finished" | "error";
        }) => Promise<void>,
      ) => {
        assert.equal(threadId, interrupted.delegation?.threadId);
        assert.equal(runId, interrupted.delegation?.runId);
        assert.equal(cursor, "event-2");
        await onEvent({ type: "TEXT_MESSAGE_START", cursor: "event-2" });
        await onEvent({ type: "RUN_FINISHED", cursor: "event-3", terminal: "finished" });
        await onEvent({ type: "RUN_ERROR", cursor: "event-4", terminal: "error" });
        return { terminal: "finished" as const, messageIds: [] };
      },
    );
    t.mock.method(second, "textResult", async () => "Recovered answer.");
    clock += 6000;
    await f.server.agent.worker.tick();
    const saved = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(saved?.status, "succeeded");
    assert.equal(saved.result, "Recovered answer.");
    assert.equal(saved.delegation?.output, "Recovered answer.");
    assert.equal(firstRun.mock.callCount(), 1);
    assert.equal(repeated.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(f.channelCalls, 1);
  } finally {
    await f.close();
  }
});

test("healthy silence delays at ten minutes and late verified completion notices once", async (t) => {
  const f = await fixture();
  try {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const response = await f.request("conversation-1", {
      requestId: "delayed",
      botId: "bot-1",
      prompt: "One answer",
    });
    const task = (await response.json()) as AgentTask;
    const gateway = f.server.agent.openbot;
    assert(gateway);
    t.mock.method(gateway, "runText", async () => ({
      terminal: "unconfirmed" as const,
      messageIds: [],
    }));
    t.mock.method(gateway, "reconnectRun", async () => ({
      terminal: "unconfirmed" as const,
      messageIds: [],
    }));
    await f.server.agent.worker.tick();
    clock += 10 * 60_000 + 5000;
    await f.server.agent.worker.tick();
    const delayed = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(delayed?.status, "running");
    assert(delayed.delegation?.delayedAt);
    const finish = t.mock.method(gateway, "reconnectRun", async () => ({
      terminal: "finished" as const,
      messageIds: ["answer-1"],
    }));
    t.mock.method(gateway, "textResult", async () => "Late answer.");
    clock += 6000;
    await f.server.agent.worker.tick();
    await f.server.agent.worker.tick();
    assert.equal((await f.db.get<AgentTask>(f.owner, "tasks", task.id))?.result, "Late answer.");
    assert.equal(finish.mock.callCount(), 1);
    assert.equal(
      (await f.db.list<{ title: string }>(f.owner, "notifications")).filter(
        (n) => n.title === "One answer",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});
