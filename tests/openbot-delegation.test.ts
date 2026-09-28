import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { OpenBotGateway } from "../apps/server/src/openbot.ts";
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
    openbotScopedReadRoot: directory,
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
    directory,
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

test("scoped registration signs the owner and exact run tuple separately from the bearer", async () => {
  let received: Record<string, string> | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body) as Record<string, string>;
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const gateway = new OpenBotGateway({
      openbotEnabled: true,
      openbotBaseUrl: `http://127.0.0.1:${address.port}`,
      openbotScopedReadToken: "shared-bearer",
      openbotScopedReadSigningKey: "independent-signing-key-at-least-32-bytes",
    } as Config);
    const owner = "owner-1";
    const path = `${createHash("sha256").update(owner).digest("hex").slice(0, 24)}/garden.txt`;
    const secret = await gateway.bindScopedRead(
      owner,
      "task-1",
      "bot-1",
      "thread-1",
      "00000000-0000-4000-8000-000000000001",
      path,
    );
    const tuple = JSON.stringify([
      owner,
      "task-1",
      "bot-1",
      "thread-1",
      "00000000-0000-4000-8000-000000000001",
      path,
    ]);
    assert.equal(received?.owner, owner);
    assert.equal(received?.runSecret, secret);
    assert.equal(
      received?.signature,
      createHmac("sha256", "independent-signing-key-at-least-32-bytes")
        .update(tuple)
        .digest("base64url"),
    );
    assert.notEqual(
      received?.signature,
      createHmac("sha256", "shared-bearer").update(tuple).digest("base64url"),
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("named resource fallback sends only relevant authorized lines and user supplied text", async () => {
  const f = await fixture();
  try {
    const ownerPath = join(
      f.directory,
      createHash("sha256").update(f.owner).digest("hex").slice(0, 24),
    );
    await mkdir(ownerPath);
    await writeFile(
      join(ownerPath, "garden.txt"),
      [
        "garden roses need sunlight",
        "garden roses PRIVATE_KEY=RELEVANT_SECRET_SENTINEL need shade",
        "garden roses Authorization: Basic dXNlcjpwYXNzMTIz need shade",
        "garden roses https://reader:P4ssw0rd@example.test/notes",
        "unrelated PRIVATE_SENTINEL_COOKIE=keep-out",
        "garden roses need water",
      ].join("\n"),
    );
    const input = {
      requestId: "scoped-fallback",
      botId: "bot-1",
      prompt: "Summarize garden roses",
      sourcePath: "garden.txt",
    };
    const response = await f.request("conversation-1", input);
    assert.equal(response.status, 201, await response.clone().text());
    const task = (await response.json()) as AgentTask;
    assert.equal(task.delegation?.readMode, "excerpt");
    assert.match(task.delegation.sentContext, /garden roses need sunlight/);
    assert.match(task.delegation.sentContext, /garden roses need water/);
    assert.doesNotMatch(task.delegation.sentContext, /PRIVATE_SENTINEL/);
    assert.doesNotMatch(task.delegation.sentContext, /RELEVANT_SECRET_SENTINEL/);
    assert.doesNotMatch(task.delegation.sentContext, /dXNlcjpwYXNzMTIz|P4ssw0rd/);
    const namedInPrompt = await f.request("conversation-1", {
      ...input,
      requestId: "named-in-prompt",
      prompt: "Summarize garden.txt",
      brief: "Read garden.txt once",
    });
    assert.equal(namedInPrompt.status, 201, await namedInPrompt.clone().text());
    const namedTask = (await namedInPrompt.json()) as AgentTask;
    assert.equal(namedTask.delegation?.sourcePath, "garden.txt");
    assert.doesNotMatch(namedTask.delegation?.sentContext ?? "", /garden\.txt/);
    await writeFile(join(ownerPath, "..notes.txt"), "garden roses from valid dot-prefixed notes");
    const dotFile = await f.request("conversation-1", {
      ...input,
      requestId: "valid-dot-filename",
      sourcePath: "..notes.txt",
    });
    assert.equal(dotFile.status, 201, await dotFile.clone().text());
    assert.match(
      ((await dotFile.json()) as AgentTask).delegation?.sentContext ?? "",
      /valid dot-prefixed notes/,
    );
    const credentialFilename = "Authorization: Basic Zm9vYmFy.txt";
    await writeFile(join(ownerPath, credentialFilename), "garden roses from unsafe filename");
    const credentialPath = await f.request("conversation-1", {
      ...input,
      requestId: "credential-filename",
      sourcePath: credentialFilename,
    });
    assert.equal(credentialPath.status, 201);
    assert.doesNotMatch(
      ((await credentialPath.json()) as AgentTask).delegation?.sentContext ?? "",
      /Zm9vYmFy|Authorization/,
    );
    const bareTokenFilename = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345.txt";
    await writeFile(join(ownerPath, bareTokenFilename), "garden roses from a file");
    const bareTokenPath = await f.request("conversation-1", {
      ...input,
      requestId: "bare-token-filename",
      sourcePath: bareTokenFilename,
    });
    assert.equal(bareTokenPath.status, 201);
    assert.doesNotMatch(
      ((await bareTokenPath.json()) as AgentTask).delegation?.sentContext ?? "",
      /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345/,
    );
    const safeNamedPath = "tokenization-notes.txt";
    await writeFile(join(ownerPath, safeNamedPath), "garden roses from tokenization notes");
    assert.equal(
      (
        await f.request("conversation-1", {
          ...input,
          requestId: "safe-named-path",
          sourcePath: safeNamedPath,
        })
      ).status,
      201,
    );
    await writeFile(
      join(ownerPath, "unsafe.txt"),
      "garden roses private key: UNSAFE_ONLY_SENTINEL",
    );
    const safeFallback = await f.request("conversation-1", {
      ...input,
      requestId: "unsafe-supplied",
      sourcePath: "unsafe.txt",
      suppliedText: "User-approved garden roses summary",
    });
    assert.equal(safeFallback.status, 201, await safeFallback.clone().text());
    const safeTask = (await safeFallback.json()) as AgentTask;
    assert.equal(safeTask.delegation?.readMode, "supplied");
    assert.match(safeTask.delegation.sentContext, /User-approved garden roses summary/);
    assert.doesNotMatch(safeTask.delegation.sentContext, /UNSAFE_ONLY_SENTINEL/);
    await symlink(join(ownerPath, "garden.txt"), join(ownerPath, "alias.txt"));
    assert.equal(
      (
        await f.request("conversation-1", {
          ...input,
          requestId: "symlink-rejected",
          sourcePath: "alias.txt",
        })
      ).status,
      422,
    );
    await writeFile(join(ownerPath, "invalid.txt"), Buffer.from([0xff]));
    assert.equal(
      (
        await f.request("conversation-1", {
          ...input,
          requestId: "invalid-rejected",
          sourcePath: "invalid.txt",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.request("conversation-1", {
          ...input,
          requestId: "traversal",
          sourcePath: "../private.txt",
        })
      ).status,
      422,
    );
    const supplied = await f.request("conversation-1", {
      requestId: "supplied",
      botId: "bot-1",
      prompt:
        "Summarize this Bearer PROMPT_SENTINEL sessionToken=CAMEL_PROMPT_SENTINEL OPENAI_API_KEY=PREFIXED_KEY_SENTINEL",
      brief: "api_key=BRIEF_SENTINEL AWS_SECRET_ACCESS_KEY=ACCESS_KEY_SENTINEL",
      suppliedText: "garden facts supplied by the user\ntoken: CONTENT_SENTINEL",
    });
    assert.equal(supplied.status, 201, await supplied.clone().text());
    const suppliedTask = (await supplied.json()) as AgentTask;
    assert.match(suppliedTask.delegation?.sentContext ?? "", /garden facts supplied by the user/);
    assert.doesNotMatch(
      JSON.stringify(suppliedTask),
      /PROMPT_SENTINEL|CAMEL_PROMPT_SENTINEL|PREFIXED_KEY_SENTINEL|BRIEF_SENTINEL|ACCESS_KEY_SENTINEL|CONTENT_SENTINEL/,
    );
    const multiline = await f.request("conversation-1", {
      requestId: "multiline-credential",
      botId: "bot-1",
      prompt:
        'Summarize supplied notes\nACME_PRIVATE_KEY="alpha beta\ngamma"\nKeep this instruction',
      brief: "OPENAI_API_KEY=\nKeep the empty assignment separate",
      suppliedText: "garden facts supplied by the user",
    });
    assert.equal(multiline.status, 201, await multiline.clone().text());
    const multilineContext = ((await multiline.json()) as AgentTask).delegation?.sentContext ?? "";
    assert.doesNotMatch(multilineContext, /alpha beta|gamma/);
    assert.match(multilineContext, /Keep this instruction/);
    assert.match(multilineContext, /Keep the empty assignment separate/);
    assert.equal(
      (
        await f.request("conversation-1", {
          requestId: "unsafe-supplied-only",
          botId: "bot-1",
          prompt: "Summarize supplied notes",
          suppliedText: "Authorization: Basic Zm9vYmFy",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await f.request("conversation-1", {
          requestId: "unsafe-camel-case-only",
          botId: "bot-1",
          prompt: "Summarize supplied notes",
          suppliedText: "sessionToken=UNSAFE_ONLY_SENTINEL",
        })
      ).status,
      422,
    );
    f.setTools([{ ref: "host/shell" }]);
    assert.equal((await f.request("conversation-1", { ...input, requestId: "broad" })).status, 409);
  } finally {
    await f.close();
  }
});

test("a saved pre-fix excerpt is sanitized before its first submission", async (t) => {
  const f = await fixture();
  try {
    const input = {
      requestId: "saved-excerpt",
      botId: "bot-1",
      prompt: "Summarize garden notes",
      suppliedText: "garden Authorization: Basic QmFzaWNBdXRoMTIz\nsafe garden notes",
    };
    const response = await f.request("conversation-1", input);
    assert.equal(response.status, 201);
    const task = (await response.json()) as AgentTask;
    assert(task.delegation);
    await f.db.put(f.owner, "tasks", {
      ...task,
      delegation: {
        ...task.delegation,
        fallbackExcerpt: "garden Authorization: Basic QmFzaWNBdXRoMTIz\nsafe garden notes",
        sentContext: "pre-fix context QmFzaWNBdXRoMTIz",
      },
    });
    const gateway = f.server.agent.openbot;
    assert(gateway);
    const expectedRunIds = new Set([task.delegation.runId]);
    const run = t.mock.method(
      gateway,
      "runText",
      async (_botId: string, _threadId: string, runId: string, text: string) => {
        assert(expectedRunIds.has(runId));
        assert.match(text, /safe garden notes|safe original text/);
        assert.doesNotMatch(text, /QmFzaWNBdXRoMTIz|VW5zYWZlQXV0aA==/);
        return { terminal: "finished" as const, messageIds: ["answer-1"] };
      },
    );
    t.mock.method(gateway, "textResult", async () => "Done.");
    await f.server.agent.worker.tick();
    assert.equal(run.mock.callCount(), 1);
    const saved = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.doesNotMatch(JSON.stringify(saved?.delegation), /QmFzaWNBdXRoMTIz/);
    const duplicate = await f.request("conversation-1", input);
    assert.equal(duplicate.status, 201);
    assert.equal(((await duplicate.json()) as AgentTask).id, task.id);
    const second = await f.request("conversation-1", {
      requestId: "saved-unsafe-only",
      botId: "bot-1",
      prompt: "Summarize garden notes",
      suppliedText: "safe original text",
    });
    const unsafeOnly = (await second.json()) as AgentTask;
    assert(unsafeOnly.delegation);
    await f.db.put(f.owner, "tasks", {
      ...unsafeOnly,
      delegation: {
        ...unsafeOnly.delegation,
        fallbackExcerpt: "garden Authorization: Basic VW5zYWZlQXV0aA==",
        sentContext: "pre-fix context VW5zYWZlQXV0aA==",
      },
    });
    await f.server.agent.worker.tick();
    assert.equal(run.mock.callCount(), 1);
    assert.equal((await f.db.get<AgentTask>(f.owner, "tasks", unsafeOnly.id))?.status, "failed");
    const legacyRetry = await f.request("conversation-1", {
      requestId: "saved-unsafe-only",
      botId: "bot-1",
      prompt: "Summarize garden notes",
      suppliedText: "garden Authorization: Basic VW5zYWZlQXV0aA==",
    });
    assert.equal(legacyRetry.status, 201);
    assert.equal(((await legacyRetry.json()) as AgentTask).id, unsafeOnly.id);
    const uncertain = await f.request("conversation-1", {
      requestId: "saved-unsafe-channel",
      botId: "bot-1",
      prompt: "Summarize garden notes",
      suppliedText: "safe original text",
    });
    const channelAttempted = (await uncertain.json()) as AgentTask;
    assert(channelAttempted.delegation);
    await f.db.put(f.owner, "tasks", {
      ...channelAttempted,
      delegation: {
        ...channelAttempted.delegation,
        channelAttempted: true,
        fallbackExcerpt: "garden Authorization: Basic VW5zYWZlQXV0aA==",
        sentContext: "pre-fix context VW5zYWZlQXV0aA==",
      },
    });
    await f.server.agent.worker.tick();
    const stillUncertain = await f.db.get<AgentTask>(f.owner, "tasks", channelAttempted.id);
    assert.notEqual(stillUncertain?.status, "failed");
    assert.equal(stillUncertain?.delegation?.submissionAttempted, false);
    assert.equal(run.mock.callCount(), 1);
    const oldPath = await f.request("conversation-1", {
      requestId: "saved-unsafe-path",
      botId: "bot-1",
      prompt: "Summarize garden notes",
      suppliedText: "safe original text",
    });
    const pathTask = (await oldPath.json()) as AgentTask;
    assert(pathTask.delegation);
    expectedRunIds.add(pathTask.delegation.runId);
    await f.db.put(f.owner, "tasks", {
      ...pathTask,
      delegation: {
        ...pathTask.delegation,
        sourcePath: "Authorization: Basic VW5zYWZlQXV0aA==.txt",
        sentContext: "pre-fix path VW5zYWZlQXV0aA==",
      },
    });
    await f.server.agent.worker.tick();
    const migratedPath = await f.db.get<AgentTask>(f.owner, "tasks", pathTask.id);
    assert.equal(migratedPath?.status, "succeeded");
    assert.doesNotMatch(migratedPath?.delegation?.sentContext ?? "", /VW5zYWZlQXV0aA==/);
    assert.equal(run.mock.callCount(), 2);
  } finally {
    await f.close();
  }
});

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
        assert.equal(text, created.delegation?.sentContext);
        assert.match(text, /^Task: Summarize this text\nRelevant brief: It is about a garden\./);
        assert.match(text, /Conversation ID: conversation-1/);
        assert.match(text, /Run ID: /);
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
    const transportLostAt = saved.delegation?.transportLostAt;
    assert(transportLostAt);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    let replay = 0;
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
        await onEvent({ type: "TEXT_MESSAGE_END", cursor: `replay-${++replay}` });
        return { terminal: "unconfirmed" as const, messageIds: [], lost: true };
      },
    );
    clock += 4 * 60_000;
    await f.server.agent.worker.tick();
    assert.equal((await f.db.get<AgentTask>(f.owner, "tasks", task.id))?.status, "running");
    clock += 60_000 + 5000;
    await f.server.agent.worker.tick();
    assert.equal((await f.db.get<AgentTask>(f.owner, "tasks", task.id))?.status, "outcome_unknown");
    assert.equal(
      (await f.db.get<AgentTask>(f.owner, "tasks", task.id))?.delegation?.transportLostAt,
      transportLostAt,
    );
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

test("restart commits a checkpointed answer when OpenBot history is unavailable", async (t) => {
  const f = await fixture();
  try {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const response = await f.request("conversation-1", {
      requestId: "checkpointed-answer",
      botId: "bot-1",
      prompt: "One answer",
    });
    const task = (await response.json()) as AgentTask;
    const first = f.server.agent.openbot;
    assert(first);
    t.mock.method(first, "runText", async () => ({
      terminal: "finished" as const,
      messageIds: ["answer-1"],
    }));
    t.mock.method(first, "textResult", async () => "Saved answer.");
    const put = f.db.put.bind(f.db);
    let interrupted = false;
    t.mock.method(
      f.db,
      "put",
      async (owner: string, collection: string, value: { id: string; kind?: string }) => {
        if (collection === "run-events" && value.kind === "result" && !interrupted) {
          interrupted = true;
          throw new Error("interrupted after answer checkpoint");
        }
        return put(owner, collection, value);
      },
    );
    await f.server.agent.worker.tick();
    const checkpointed = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(checkpointed?.status, "running");
    assert.equal(checkpointed.delegation?.terminal, "finished");
    assert.equal(checkpointed.delegation?.output, "Saved answer.");
    await f.restart();
    const second = f.server.agent.openbot;
    assert(second);
    const history = t.mock.method(second, "textResult", async () => {
      throw new Error("history unavailable");
    });
    clock += 6000;
    await f.server.agent.worker.tick();
    const saved = await f.db.get<AgentTask>(f.owner, "tasks", task.id);
    assert.equal(saved?.status, "succeeded");
    assert.equal(saved.result, "Saved answer.");
    assert.equal(history.mock.callCount(), 0);
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
