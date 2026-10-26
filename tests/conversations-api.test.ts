import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string;
const calls: { url: string; init?: RequestInit }[] = [];
let reply: unknown = { conversations: [], hasMore: false };
let status = 200;
let offline = false;
const fetchBridge = async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), init });
  if (offline) throw new Error("secret-network-detail");
  return Response.json(reply, { status });
};
let app: Awaited<ReturnType<typeof createApp>>["app"];
let config: Config;
let headers: Record<string, string>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-conversations-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "agui",
    agentUrl: "http://bridge.test/prefix/run",
    agentToken: "private-bridge-token",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  ({ app } = await createApp(db, config, { fetch: fetchBridge }));
  const session = await app.request("/api/session", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  headers = {
    Authorization: `Bearer ${(await session.json()).token}`,
    "Content-Type": "application/json",
  };
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("create, history and updates use fixed authenticated bridge contracts", async () => {
  const messages = [
    {
      id: "a",
      role: "assistant",
      content: "Working",
      toolCalls: [{ id: "tool", type: "function", function: { name: "search", arguments: "{}" } }],
    },
    { id: "b", role: "tool", toolCallId: "tool", content: "result" },
  ];
  for (const [path, method, body, expected] of [
    [
      "/api/conversations",
      "POST",
      { id: "old-thread", endpoint: "http://evil.test", owner: "forged" },
      { id: "om_canonical", existing: true },
    ],
    ["/api/conversations/om_canonical/messages", "GET", undefined, { messages }],
    [
      "/api/conversations/om_canonical",
      "PATCH",
      { title: "Renamed", archived: true, owner: "forged" },
      { id: "om_canonical", title: "Renamed", archived: true },
    ],
  ] as const) {
    calls.length = 0;
    reply = expected;
    const init = { method, body: body ? JSON.stringify(body) : undefined };
    assert.equal((await app.request(path, init)).status, 401);
    assert.equal(calls.length, 0);
    const response = await app.request(path, { ...init, headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(calls[0].url, `http://bridge.test/prefix${path.slice(4)}`);
    assert.equal(calls[0].init?.method, method);
    if (body)
      assert.deepEqual(
        JSON.parse(String(calls[0].init?.body)),
        method === "POST" ? { id: "old-thread" } : { title: "Renamed", archived: true },
      );
  }
});

test("AG-UI main thread ensures the persisted seed and returns canonical identity on every request", async () => {
  const seed = "5a1c0000-0000-4000-8000-000000000001";
  await db.put("local-user", "conversation-settings", {
    id: "main",
    threadId: seed,
    existing: false,
  });
  reply = { id: "om_canonical", existing: true };
  calls.length = 0;
  for (let i = 0; i < 2; i++) {
    const response = await app.request("/api/main-thread", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { threadId: "om_canonical", existing: true });
  }
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (call) =>
        call.url === "http://bridge.test/prefix/conversations" &&
        call.init?.method === "POST" &&
        call.init?.body === JSON.stringify({ id: seed }),
    ),
  );
  assert.equal(
    (await db.get<{ threadId: string }>("local-user", "conversation-settings", "main"))?.threadId,
    seed,
  );
});

test("workspace advertises AG-UI without imaginary Rich Threads", async () => {
  const response = await app.request("/api/workspace", { headers });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.runtime.provider, "agui");
  assert.equal(snapshot.runtime.richThreads, false);
  assert.ok(!JSON.stringify(snapshot).includes("private-bridge-token"));
});

test("bridge failures are concise, never successful placeholders or upstream secrets", async () => {
  for (const code of [401, 403, 404, 500]) {
    status = code;
    reply = { error: "private-bridge-token secret-stack" };
    for (const path of ["/api/conversations", "/api/main-thread"]) {
      const response = await app.request(path, { headers });
      assert.equal(response.status, code === 404 ? 404 : 502);
      assert.ok(!/private-bridge-token|secret-stack/.test(await response.text()));
    }
  }
  status = 200;
  offline = true;
  assert.equal((await app.request("/api/conversations", { headers })).status, 502);
  offline = false;
});

test("missing backend, endpoint or auth fails before any bridge request", async () => {
  const original = { ...config };
  try {
    for (const overrides of [
      { agentBackend: "sample" as const },
      { agentUrl: undefined },
      { agentUrl: "http://bridge.test/other" },
      { agentUrl: "http://bridge.test/run?target=evil" },
      { agentToken: undefined },
      { agentToken: " " },
    ]) {
      Object.assign(config, original, overrides);
      calls.length = 0;
      const response = await app.request("/api/conversations", { headers });
      assert.equal(response.status, 503);
      assert.equal(calls.length, 0);
    }
  } finally {
    Object.assign(config, original);
  }
});

test("invalid pagination and mutations never reach the bridge", async () => {
  calls.length = 0;
  for (const [path, method, body] of [
    ["/api/conversations?limit=-1", "GET", undefined],
    ["/api/conversations?offset=1.5", "GET", undefined],
    ["/api/conversations", "POST", { id: "" }],
    ["/api/conversations/om_canonical", "PATCH", { archived: "true" }],
    ["/api/conversations/om_canonical", "PATCH", {}],
  ] as const) {
    assert.equal(
      (await app.request(path, { method, headers, body: body ? JSON.stringify(body) : undefined }))
        .status,
      422,
    );
  }
  assert.equal(calls.length, 0);
});

test("conversation identifiers cannot escape the fixed route", async () => {
  calls.length = 0;
  for (const path of [
    "/api/conversations/bad%3Fid/messages",
    "/api/conversations/bad%2Fid/messages",
  ]) {
    assert.equal((await app.request(path, { headers })).status, 422);
  }
  assert.equal(calls.length, 0);
});

test("conversation list requires owner auth and forwards only pagination to configured bridge", async () => {
  calls.length = 0;
  assert.equal((await app.request("/api/conversations")).status, 401);
  assert.equal(calls.length, 0);
  reply = {
    conversations: [
      {
        id: "om_123",
        title: "Trip",
        archived: false,
        updatedAt: "2026-10-26T00:00:00Z",
        preview: "hello",
      },
    ],
    hasMore: true,
  };
  const response = await app.request(
    "/api/conversations?limit=5&offset=10&endpoint=http://evil.test&owner=forged",
    { headers },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), reply);
  assert.equal(calls[0].url, "http://bridge.test/prefix/conversations?limit=5&offset=10");
  assert.equal(
    new Headers(calls[0].init?.headers).get("Authorization"),
    "Bearer private-bridge-token",
  );
  calls.length = 0;
  await app.request("/api/conversations", { headers });
  assert.equal(calls[0].url, "http://bridge.test/prefix/conversations?limit=20&offset=0");
});
