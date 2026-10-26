import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createBridgeApp } from "../apps/bridge/src/app.ts";
import { bridgeConfig } from "../apps/bridge/src/config.ts";
import { createHermesUpstream, sessionIdFor, sseFrames } from "../apps/bridge/src/hermes.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const sessions = new Map<
    string,
    { id: string; source: string; title: string; archived: boolean; started_at: number }
  >();
  const calls: string[] = [];
  const streamFrames: { event: string; data: unknown }[] = [];
  const remote = new Hono();
  remote.post(
    "/api/sessions/:id/chat/stream",
    () =>
      new Response(
        streamFrames
          .map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  remote.post("/api/sessions", async (c) => {
    const body = await c.req.json();
    if (sessions.has(body.id)) return c.json({ error: "already exists" }, 409);
    const session = {
      id: body.id,
      source: "api_server",
      title: body.title || "",
      archived: false,
      started_at: 1,
    };
    sessions.set(body.id, session);
    return c.json({ session }, 201);
  });
  remote.get("/api/sessions", (c) =>
    c.json({ data: [...sessions.values()].filter((s) => !s.archived), has_more: false }),
  );
  remote.get("/api/sessions/:id", (c) => {
    calls.push(c.req.param("id"));
    const session = sessions.get(c.req.param("id"));
    return session ? c.json({ session }) : c.json({ error: "missing" }, 404);
  });
  remote.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id"),
      row = sessions.get(id);
    if (!row) return c.json({ error: "missing" }, 404);
    Object.assign(row, await c.req.json());
    return c.json({ session: row });
  });
  const history = [
    { id: 1, role: "user", content: "remember the blue bicycle" },
    { id: 2, role: "assistant", content: "I will.", tool_calls: null },
  ];
  remote.get("/api/sessions/:id/messages", (c) => {
    const offset = Number(c.req.query("offset") || 0),
      limit = Number(c.req.query("limit") || 500);
    const start =
      c.req.query("order") === "latest" ? Math.max(0, history.length - offset - limit) : offset;
    return c.json({ data: history.slice(start, start + limit) });
  });
  const server = serve({ fetch: remote.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const dir = await mkdtemp(join(tmpdir(), "om-conversations-"));
  t.after(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const cfg = bridgeConfig({
    BRIDGE_TOKEN: token,
    HERMES_API_KEY: "upstream-test-key",
    HERMES_BASE_URL: `http://127.0.0.1:${address.port}`,
    BRIDGE_DATA_DIR: dir,
  });
  const make = () => createBridgeApp(cfg, { upstream });
  const request = (
    app: ReturnType<typeof make>,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { sessions, calls, make, request, streamFrames, cfg, history };
}

test("creating a conversation is idempotent and uses one canonical Hermes identity", async (t) => {
  const f = await fixture(t),
    app = f.make();
  const response = await f.request(app, "/conversations", { id: "original-openmuse-thread" });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.id, sessionIdFor("original-openmuse-thread"));
  const again = await f.request(app, "/conversations", { id: created.id });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, created.id);
  assert.equal(f.sessions.size, 1);
});

test("archived conversations remain discoverable after bridge restart and can be restored", async (t) => {
  const f = await fixture(t),
    app = f.make();
  const created = await (await f.request(app, "/conversations", { id: "archive-me" })).json();
  const archived = await f.request(
    app,
    `/conversations/${created.id}`,
    { title: "My day", archived: true },
    "PATCH",
  );
  assert.equal(archived.status, 200);
  const list = await f.request(f.make(), "/conversations?limit=20&offset=0");
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(
    body.conversations.map((c: { id: string; title: string; archived: boolean }) => [
      c.id,
      c.title,
      c.archived,
    ]),
    [[created.id, "My day", true]],
  );
  assert.equal(body.hasMore, false);
  const restored = await f.request(
    f.make(),
    `/conversations/${created.id}`,
    { archived: false },
    "PATCH",
  );
  assert.equal(restored.status, 200);
  assert.equal(f.sessions.get(created.id)?.archived, false);
});

test("Hermes history survives bridge recreation and unrelated sessions stay private", async (t) => {
  const f = await fixture(t);
  const created = await (await f.request(f.make(), "/conversations", { id: "history" })).json();
  const history = await f.request(f.make(), `/conversations/${created.id}/messages`);
  assert.equal(history.status, 200);
  const body = await history.json();
  assert.deepEqual(
    body.messages.map((m: { role: string; content: string }) => [m.role, m.content]),
    [
      ["user", "remember the blue bicycle"],
      ["assistant", "I will."],
    ],
  );
  assert.ok(body.messages.every((m: { id: unknown }) => typeof m.id === "string"));
  f.sessions.set("private-session", {
    id: "private-session",
    source: "api_server",
    title: "private",
    archived: false,
    started_at: 2,
  });
  const unrelated = await f.request(f.make(), "/conversations/private-session/messages");
  assert.equal(unrelated.status, 404);
  assert.ok(!f.calls.includes("private-session"));
  const impostorId = sessionIdFor("foreign");
  f.sessions.set(impostorId, {
    id: impostorId,
    source: "cli",
    title: "private",
    archived: false,
    started_at: 2,
  });
  assert.equal((await f.request(f.make(), `/conversations/${impostorId}/messages`)).status, 404);
});

test("saved history includes older pages in chronological order", async (t) => {
  const f = await fixture(t),
    app = f.make();
  f.history.splice(
    0,
    f.history.length,
    ...Array.from({ length: 503 }, (_, id) => ({ id, role: "user", content: `message ${id}` })),
  );
  const created = await (await f.request(app, "/conversations", { id: "long-history" })).json();
  const response = await f.request(app, `/conversations/${created.id}/messages`);
  assert.equal(response.status, 200);
  const { messages } = await response.json();
  assert.equal(messages.length, 503);
  assert.equal(messages[0].content, "message 0");
  assert.equal(messages[502].content, "message 502");
});

test("real Hermes tool lifecycle produces AG-UI tool cards without inventing tool output", async (t) => {
  const f = await fixture(t);
  f.streamFrames.push(
    {
      event: "tool.started",
      data: { tool_name: "web_search", args: { query: "weather" }, preview: "Searching" },
    },
    { event: "tool.completed", data: { tool_name: "web_search", preview: "Finished search" } },
    { event: "assistant.delta", data: { delta: "Answer" } },
    { event: "done", data: {} },
  );
  const app = createBridgeApp(f.cfg, { upstream: createHermesUpstream(f.cfg) });
  const response = await f.request(app, "/run", {
    threadId: "tool-conversation",
    runId: "tools-1",
    messages: [{ role: "user", content: "weather" }],
  });
  const events = (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
  assert.ok(events.some((e) => e.type === "TOOL_CALL_START" && e.toolCallName === "web_search"));
  const result = events.find((e) => e.type === "TOOL_CALL_RESULT");
  assert.ok(result);
  assert.equal(JSON.parse(result.content).preview, "Finished search");
  assert.equal(JSON.parse(result.content).fullOutputAvailable, false);
});

test("overlapping same-name tool results stay unattributed without upstream call IDs", async (t) => {
  const f = await fixture(t);
  f.streamFrames.push(
    { event: "tool.started", data: { tool_name: "terminal", args: { command: "first" } } },
    { event: "tool.started", data: { tool_name: "terminal", args: { command: "second" } } },
    { event: "tool.completed", data: { tool_name: "terminal", preview: "second finished first" } },
    { event: "tool.failed", data: { tool_name: "terminal", preview: "first failed last" } },
    { event: "assistant.delta", data: { delta: "Finished." } },
    { event: "done", data: {} },
  );
  const app = createBridgeApp(f.cfg, { upstream: createHermesUpstream(f.cfg) });
  const response = await f.request(app, "/run", {
    threadId: "overlap-tools",
    runId: "overlap-1",
    messages: [{ role: "user", content: "run both" }],
  });
  const events = (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
  const results = events
    .filter((e) => e.type === "TOOL_CALL_RESULT")
    .map((e) => JSON.parse(e.content));
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.attributionUnknown === true));
  assert.ok(
    results.every(
      (r) => !r.preview.includes("finished first") && !r.preview.includes("failed last"),
    ),
  );
});

test("partial streams and failed Hermes runs never become successful replies", async (t) => {
  const f = await fixture(t);
  for (const ending of [
    [],
    [
      { event: "run.failed", data: { message: "stopped" } },
      { event: "done", data: {} },
    ],
  ]) {
    f.streamFrames.splice(
      0,
      f.streamFrames.length,
      { event: "assistant.delta", data: { delta: "Partial output" } },
      ...ending,
    );
    const app = createBridgeApp(f.cfg, { upstream: createHermesUpstream(f.cfg) });
    const response = await f.request(app, "/run", {
      threadId: "interrupted",
      runId: "interrupted-1",
      messages: [{ role: "user", content: "hello" }],
    });
    const text = await response.text();
    assert.ok(text.includes('"RUN_ERROR"'), text);
    assert.ok(!text.includes('"RUN_FINISHED"'), text);
  }
});

test("SSE survives CRLF split across transport chunks", async () => {
  const cr = String.fromCharCode(13),
    lf = String.fromCharCode(10);
  const input = [
    `event: assistant.delta${cr}`,
    `${lf}data: {"delta":"hello"}${cr}`,
    `${lf}${cr}`,
    `${lf}event: done${cr}${lf}data: {}${cr}${lf}${cr}${lf}`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of input) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  const events = [];
  for await (const frame of sseFrames(stream)) events.push(frame);
  assert.deepEqual(events, [
    { event: "assistant.delta", data: '{"delta":"hello"}' },
    { event: "done", data: "{}" },
  ]);
});

test("unregistered canonical IDs cannot be adopted, discovered, read, changed, or run", async (t) => {
  const f = await fixture(t),
    id = sessionIdFor("foreign-owned-session");
  f.sessions.set(id, {
    id,
    source: "api_server",
    title: "Private",
    archived: false,
    started_at: 1,
  });
  const app = f.make();
  assert.equal((await f.request(app, `/conversations/${id}/messages`)).status, 404);
  assert.equal(
    (await f.request(app, `/conversations/${id}`, { title: "changed" }, "PATCH")).status,
    404,
  );
  assert.equal((await f.request(app, "/conversations", { id })).status, 404);
  assert.equal(
    (await f.request(app, "/conversations", { id: "foreign-owned-session" })).status,
    409,
  );
  assert.deepEqual((await (await f.request(app, "/conversations")).json()).conversations, []);
  const real = createBridgeApp(f.cfg, { upstream: createHermesUpstream(f.cfg) });
  const response = await f.request(real, "/run", {
    threadId: id,
    runId: "foreign",
    messages: [{ role: "user", content: "hello" }],
  });
  const frames = await response.text();
  assert.ok(frames.includes('"RUN_ERROR"'));
  assert.ok(!frames.includes('"RUN_FINISHED"'));
  assert.equal(f.sessions.get(id)?.title, "Private");
});

test("concurrent creation returns one owned identity without dropping other registrations", async (t) => {
  const f = await fixture(t),
    app = f.make();
  const responses = await Promise.all(
    ["same-seed", "same-seed", "other-seed"].map((id) => f.request(app, "/conversations", { id })),
  );
  assert.ok(responses.every((r) => r.ok));
  const created = await Promise.all(responses.map((r) => r.json()));
  assert.equal(created[0].id, created[1].id);
  const listed = await (await f.request(f.make(), "/conversations")).json();
  assert.equal(listed.conversations.length, 2);
});

const token = "bridge-conversations-test-token";
const config = bridgeConfig({ BRIDGE_TOKEN: token, HERMES_API_KEY: "upstream-test-key" });
const upstream = {
  async probe() {
    return { ok: true };
  },
  async *run() {
    yield { type: "done" as const };
  },
};

test("conversation routes reject unauthenticated access before any upstream call", async () => {
  const app = createBridgeApp(config, { upstream });
  for (const method of ["GET", "POST", "PATCH"]) {
    const response = await app.request(
      method === "PATCH" ? "/conversations/unknown" : "/conversations",
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      },
    );
    assert.equal(response.status, 401, method);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  }
});
