import assert from "node:assert/strict";
import test from "node:test";
import { IntelligenceAgent } from "@copilotkit/core";
import { Observable } from "rxjs";
import {
  OpenBotAdapter,
  OpenBotError,
  type OpenBotTransport,
} from "../packages/backends/src/openbot.ts";

type RequestHandler = (path: string, init: RequestInit) => Response | Promise<Response>;
function fixture(handler: RequestHandler) {
  const calls: { path: string; init: RequestInit }[] = [];
  const transport: OpenBotTransport = {
    runtimeUrl: "https://openbot.example/api/copilotkit",
    async request(path, init = {}) {
      calls.push({ path, init });
      return handler(path, init);
    },
  };
  return {
    transport,
    calls,
    adapter: new OpenBotAdapter({ enabled: true, transport, agentId: "bot-1" }),
  };
}
const control = { holder: "human", since: "2026-09-15T12:00:00Z", requested: false };
const navigation = {
  url: "https://example.com/",
  title: "Example",
  text: "Hello",
  truncated: false,
  elapsedMs: 50,
};

test("delegation eligibility requires empty effective plugin and host grants", async () => {
  let held = false;
  const { adapter } = fixture((path) =>
    Response.json(
      path.startsWith("/api/plugins/for/")
        ? { tools: held ? [{ ref: "host/shell" }] : [], skills: [] }
        : { grants: [], pending: [], connected: false },
    ),
  );
  assert.equal(await adapter.hasNoEffectiveGrants("bot-1"), true);
  held = true;
  assert.equal(await adapter.hasNoEffectiveGrants("bot-1"), false);
});

test("only a terminal matching the saved thread and run can settle a delegated attempt", async (t) => {
  const { adapter, transport } = fixture(() => Response.json({}));
  const events = [
    { type: "RUN_FINISHED", threadId: "other-thread", runId: "run-1" },
    { type: "RUN_FINISHED", threadId: "thread-1", runId: "other-run" },
  ];
  t.mock.method(
    IntelligenceAgent.prototype,
    "run",
    () =>
      new Observable((subscriber) => {
        for (const event of events) subscriber.next(event);
        subscriber.complete();
      }),
  );
  transport.socketUrl = "ws://openbot.example/socket";
  assert.equal(
    (await adapter.runText("bot-1", "thread-1", "run-1", "Task only", async () => {})).terminal,
    "unconfirmed",
  );
  events.push({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" });
  assert.equal(
    (await adapter.runText("bot-1", "thread-1", "run-1", "Task only", async () => {})).terminal,
    "finished",
  );
});

test("a saved answer must have a message ID emitted by the matching run", async (t) => {
  const { adapter, transport } = fixture((path) => {
    assert.match(path, /\/messages\?/);
    return Response.json({
      messages: [
        { id: "answer-1", role: "assistant", content: "The linked answer" },
        { id: "other-answer", role: "assistant", content: "Another native chat reply" },
      ],
    });
  });
  transport.socketUrl = "ws://openbot.example/socket";
  t.mock.method(
    IntelligenceAgent.prototype,
    "run",
    () =>
      new Observable((subscriber) => {
        subscriber.next({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
        subscriber.next({ type: "TEXT_MESSAGE_START", role: "assistant", messageId: "answer-1" });
        subscriber.next({ type: "TEXT_MESSAGE_END", messageId: "answer-1" });
        subscriber.next({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" });
        subscriber.complete();
      }),
  );
  const run = await adapter.runText("bot-1", "thread-1", "run-1", "Task only", async () => {});
  assert.deepEqual(run, { terminal: "finished", messageIds: ["answer-1"] });
  assert.equal(await adapter.textResult("bot-1", "thread-1", run.messageIds), "The linked answer");
  assert.equal(await adapter.textResult("bot-1", "thread-1", ["missing"]), "");
});

test("reconnect uses the saved cursor and ignores another run's events", async (t) => {
  const { adapter, transport } = fixture(() => {
    throw new Error("reconnect must not submit a run");
  });
  transport.socketUrl = "ws://openbot.example/socket";
  const prototype = IntelligenceAgent.prototype as unknown as {
    connect(input: unknown): Observable<unknown>;
    getLastSeenEventId(threadId: string): string | null;
  };
  t.mock.method(prototype, "connect", function (this: typeof prototype) {
    assert.equal(this.getLastSeenEventId("thread-1"), "event-2");
    return new Observable((subscriber) => {
      subscriber.next({ type: "RUN_STARTED", threadId: "other-thread", runId: "run-1" });
      subscriber.next({ type: "TEXT_MESSAGE_START", role: "assistant", messageId: "wrong" });
      subscriber.next({ type: "RUN_FINISHED", threadId: "thread-1", runId: "other-run" });
      subscriber.next({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
      subscriber.next({
        type: "TEXT_MESSAGE_START",
        role: "assistant",
        messageId: "answer-1",
        metadata: { cpki_event_id: "event-3" },
      });
      subscriber.next({ type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" });
      subscriber.complete();
    });
  });
  const seen: string[] = [];
  const result = await adapter.reconnectRun(
    "bot-1",
    "thread-1",
    "run-1",
    "event-2",
    async (event) => {
      seen.push(event.type);
      if (event.messageId) assert.equal(event.cursor, "event-3");
    },
  );
  assert.equal(result.terminal, "finished");
  assert.deepEqual(result.messageIds, ["answer-1"]);
  assert.deepEqual(seen, ["RUN_STARTED", "TEXT_MESSAGE_START", "RUN_FINISHED"]);
});

test("OpenBot is disabled by default and cannot call a supplied transport", async () => {
  const { transport, calls } = fixture(() => Response.json({}));
  const adapter = new OpenBotAdapter({ transport, agentId: "bot-1" });
  assert.deepEqual(await adapter.probe(), { state: "disabled" });
  assert.throws(() => adapter.runtime(), { code: "disabled" });
  await assert.rejects(adapter.computerStatus("bot-1"), { code: "disabled" });
  await assert.rejects(adapter.navigate("bot-1", { url: "https://example.com" }), {
    code: "disabled",
  });
  assert.equal(calls.length, 0);
});

test("enabled configuration requires an authenticated transport and an agent for runtime", async () => {
  const adapter = new OpenBotAdapter({ enabled: true });
  assert.deepEqual(await adapter.probe(), { state: "not_configured" });
  assert.throws(() => adapter.runtime(), { code: "not_configured" });
  const { transport } = fixture(() => Response.json({}));
  assert.throws(() => new OpenBotAdapter({ enabled: true, transport }).runtime(), {
    code: "not_configured",
  });
});

test("runtime is an Intelligence descriptor and reports unsupported capabilities without a connection claim", () => {
  const { adapter, calls } = fixture(() => Response.json({}));
  assert.deepEqual(adapter.runtime(), {
    runtimeUrl: "https://openbot.example/api/copilotkit",
    agentId: "bot-1",
    mode: "intelligence",
    credentials: "include",
  });
  assert.deepEqual(adapter.unsupportedCapabilities, [
    "gmail",
    "calendar",
    "pdf",
    "approval_persistence",
  ]);
  assert.equal(calls.length, 0);
});

test("probe verifies user identity before reporting authenticated Intelligence capabilities", async () => {
  const { adapter, calls } = fixture((path, init) => {
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), null);
    return Response.json(
      path === "/api/me"
        ? { user: { id: "person-1", email: "person@example.com", secret: "not-projected" } }
        : {
            mode: "intelligence",
            durableHistory: true,
            generativeUi: false,
            authProviders: ["google"],
          },
    );
  });
  assert.deepEqual(await adapter.probe(), {
    state: "authenticated",
    userId: "person-1",
    mode: "intelligence",
    durableHistory: true,
    generativeUi: false,
  });
  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/api/me", "/api/capabilities"],
  );
});

test("probe does not treat anonymous runtime discovery as authentication", async () => {
  const { adapter, calls } = fixture(() =>
    Response.json({ error: "Authentication required." }, { status: 401 }),
  );
  assert.deepEqual(await adapter.probe(), { state: "authentication_required" });
  assert.equal(calls.length, 1);
});

test("probe rejects incompatible capability responses and exposes transport failure", async () => {
  const { adapter } = fixture((path) =>
    Response.json(
      path === "/api/me" ? { user: { id: "person-1" } } : { mode: "sse", durableHistory: false },
    ),
  );
  assert.equal((await adapter.probe()).state, "unavailable");
  const broken = fixture(() => {
    throw new Error("synthetic transport failure");
  });
  assert.equal((await broken.adapter.probe()).state, "unavailable");
});

test("channel creation preserves separate channel, thread and agent identities", async () => {
  const { adapter, calls } = fixture((path, init) => {
    assert.equal(path, "/api/channels");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { agentIds: ["bot-1"] });
    return Response.json({
      channel: { id: "channel-2", threadId: "thread-3", agentIds: ["bot-1"], active: true },
    });
  });
  assert.deepEqual(await adapter.createConversation("bot-1"), {
    channelId: "channel-2",
    threadId: "thread-3",
    agentIds: ["bot-1"],
  });
  assert.equal(calls.length, 1);
});

test("computer status uses a Bot ID and rejects unknown lifecycle states or mismatched identity", async () => {
  const { adapter, calls } = fixture(() =>
    Response.json({ botId: "bot/a", state: "unreachable", reason: "Computer stopped responding." }),
  );
  assert.deepEqual(await adapter.computerStatus("bot/a"), {
    botId: "bot/a",
    state: "unreachable",
    reason: "Computer stopped responding.",
  });
  assert.equal(calls[0].path, "/api/computers/bot%2Fa/status");
  for (const response of [
    { botId: "bot-1", state: "running" },
    { botId: "other", state: "ready" },
  ]) {
    const invalid = fixture(() => Response.json(response));
    await assert.rejects(invalid.adapter.computerStatus("bot-1"), { code: "invalid_response" });
  }
});

test("snapshot is a read that retains server-owned references", async () => {
  const snapshot = {
    snapshotId: 7,
    url: "https://example.com",
    title: "Example",
    elements: [{ ref: "opaque", role: "button", name: "Continue" }],
    truncated: false,
  };
  const { adapter, calls } = fixture(() => Response.json(snapshot));
  assert.deepEqual(await adapter.snapshot("bot-1"), snapshot);
  assert.equal(calls[0].path, "/api/computers/bot-1/snapshot");
  assert.equal(calls[0].init.method, "POST");
});

test("navigation uses the policy gateway, preserves cancellation and never creates a direct computer URL", async () => {
  const { adapter, calls } = fixture(() => Response.json(navigation));
  const controller = new AbortController();
  assert.deepEqual(
    await adapter.navigate(
      "bot-1",
      { url: "https://example.com/", toolCallId: "call-1" },
      controller.signal,
    ),
    navigation,
  );
  assert.equal(calls[0].path, "/api/computers/bot-1/navigate");
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    url: "https://example.com/",
    toolCallId: "call-1",
  });
  await assert.rejects(adapter.navigate("bot-1", { url: "file:///etc/passwd" }), {
    code: "invalid_input",
  });
  await assert.rejects(adapter.computerStatus(".."), { code: "invalid_input" });
  assert.equal(calls.length, 1);
});

test("human control reads and transitions use the exact audited gateway routes", async () => {
  const { adapter, calls } = fixture(() => Response.json(control));
  assert.deepEqual(await adapter.computerControl("bot-1"), control);
  assert.deepEqual(await adapter.requestControl("bot-1", "Complete sign in"), control);
  assert.deepEqual(await adapter.takeControl("bot-1"), control);
  assert.deepEqual(await adapter.releaseControl("bot-1"), control);
  assert.deepEqual(
    calls.map(({ path, init }) => [path, init.method]),
    [
      ["/api/computers/bot-1/control", "GET"],
      ["/api/computers/bot-1/control/request", "POST"],
      ["/api/computers/bot-1/control/take", "POST"],
      ["/api/computers/bot-1/control/release", "POST"],
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { reason: "Complete sign in" });
});

test("policy refusals preserve status and rule and are never retried", async () => {
  const { adapter, calls } = fixture(() =>
    Response.json({ error: "Navigation blocked.", rule: "deny-private" }, { status: 403 }),
  );
  await assert.rejects(adapter.navigate("bot-1", { url: "https://example.com" }), (error) => {
    assert.ok(error instanceof OpenBotError);
    assert.equal(error.code, "refused");
    assert.equal(error.status, 403);
    assert.equal(error.rule, "deny-private");
    assert.equal(error.outcomeUnknown, false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("uncertain mutations require reconciliation after transport, server or invalid-response failure", async () => {
  for (const handler of [
    () => {
      throw new Error("connection dropped");
    },
    () => new Response("upstream unavailable", { status: 503 }),
    () => Response.json({ unexpected: true }),
  ]) {
    const { adapter, calls } = fixture(handler);
    await assert.rejects(adapter.navigate("bot-1", { url: "https://example.com" }), (error) => {
      assert.ok(error instanceof OpenBotError);
      assert.equal(error.outcomeUnknown, true);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});
