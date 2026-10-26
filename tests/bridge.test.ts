import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { createBridgeApp } from "../apps/bridge/src/app.ts";
import { bridgeConfig } from "../apps/bridge/src/config.ts";
import type { UpstreamAgent, UpstreamRun } from "../apps/bridge/src/upstream.ts";

const TOKEN = "test-bridge-token-0123456789abcdef";

function config(overrides: Partial<Parameters<typeof bridgeConfig>[0]> = {}) {
  return bridgeConfig({
    BRIDGE_TOKEN: TOKEN,
    HERMES_API_KEY: "test-hermes-key-never-sent",
    HERMES_BASE_URL: "http://127.0.0.1:8642",
    ...overrides,
  });
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "conversation-1",
    runId: "run-1",
    state: {},
    messages: [{ id: "m1", role: "user", content: "hello there" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

/** A stand-in upstream: it records what the bridge asked for and replays fixed events. */
function fakeUpstream(
  events: Awaited<ReturnType<UpstreamAgent["run"]>> extends AsyncIterable<infer E> ? E[] : never,
  options: { reachable?: boolean } = {},
) {
  const runs: UpstreamRun[] = [];
  const agent: UpstreamAgent = {
    async probe() {
      return options.reachable === false
        ? { ok: false, detail: "connection refused" }
        : { ok: true };
    },
    async *run(input) {
      runs.push(input);
      for (const event of events) yield event;
    },
  };
  return { agent, runs };
}

async function post(app: ReturnType<typeof createBridgeApp>, body: unknown, token = TOKEN) {
  return app.request("/run", {
    method: "POST",
    headers: token
      ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
      : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function eventsOf(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.slice("data:".length).trim()) as { type: string });
}

test("a run without the bridge token is refused without leaking detail", async () => {
  const { agent } = fakeUpstream([]);
  const app = createBridgeApp(config(), { upstream: agent });
  const response = await post(app, runInput(), "");
  assert.equal(response.status, 401);
  const body = await response.text();
  assert.ok(!body.includes(TOKEN));
  assert.ok(!body.includes("hermes"));
  assert.ok(!body.includes("8642"));
});

test("a turn streams the AG-UI sequence a client expects", async () => {
  const { agent } = fakeUpstream([
    { type: "text", delta: "hel" },
    { type: "text", delta: "lo" },
    { type: "done" },
  ]);
  const app = createBridgeApp(config(), { upstream: agent });
  const response = await post(app, runInput());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await eventsOf(response);

  assert.equal(events[0]?.type, EventType.RUN_STARTED);
  assert.equal(events[1]?.type, EventType.TEXT_MESSAGE_START);
  const deltas = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
  assert.equal(deltas.length, 2);
  assert.equal(events.at(-2)?.type, EventType.TEXT_MESSAGE_END);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
});

test("an upstream failure is a run error, never a fabricated reply", async () => {
  const { agent } = fakeUpstream([{ type: "error", message: "upstream is unavailable" }]);
  const app = createBridgeApp(config(), { upstream: agent });
  const events = await eventsOf(await post(app, runInput()));
  const error = events.find((e) => e.type === EventType.RUN_ERROR) as
    | { message?: string }
    | undefined;
  assert.ok(error, "expected a RUN_ERROR event");
  assert.match(String(error.message), /unavailable/);
  assert.ok(
    !events.some((e) => e.type === EventType.RUN_FINISHED),
    "a failed run must not report success",
  );
});

test("health reports its own liveness separately from upstream reachability", async () => {
  const up = fakeUpstream([], { reachable: true });
  const app = createBridgeApp(config(), { upstream: up.agent });
  const healthy = await app.request("/health");
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, upstream: "ok" });

  const down = fakeUpstream([], { reachable: false });
  const degraded = createBridgeApp(config(), { upstream: down.agent });
  const response = await degraded.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, upstream: "unreachable" });
});

test("the upstream target comes from the bridge configuration, not the request", async () => {
  const { agent, runs } = fakeUpstream([{ type: "done" }]);
  const app = createBridgeApp(config(), { upstream: agent });
  const response = await post(
    app,
    runInput({
      forwardedProps: { baseUrl: "http://attacker.invalid", apiKey: "stolen", upstream: "evil" },
    }),
  );
  // The stream is pulled lazily, so drain it before asserting what upstream received.
  await response.text();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.text, "hello there");
  assert.equal(Object.hasOwn(runs[0] ?? {}, "baseUrl"), false);
  assert.equal(Object.hasOwn(runs[0] ?? {}, "apiKey"), false);
});

test("a missing or short bridge token stops the bridge from starting", () => {
  assert.throws(() => config({ BRIDGE_TOKEN: "" }), /BRIDGE_TOKEN/);
  assert.throws(() => config({ BRIDGE_TOKEN: "short" }), /BRIDGE_TOKEN/);
  assert.throws(() => config({ HERMES_API_KEY: "" }), /HERMES_API_KEY/);
  assert.throws(() => config({ HERMES_BASE_URL: "not a url" }), /HERMES_BASE_URL/);
});
