import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { modelFixture } from "./helpers/model.ts";

type Bot = { id: string; name: string; title?: string; hidden?: boolean; endpoint?: string | null };

async function fixture(
  t: TestContext,
  calls: ({ name: string; arguments: object } | undefined)[],
  scopedReads?: boolean,
) {
  const { requests } = await modelFixture(t, (index) => calls[index]);
  const directory = await mkdtemp(join(tmpdir(), "openmuse-routing-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  let eligibilityChecks = 0;
  const openbot =
    scopedReads !== undefined
      ? createServer((request, response) => {
          response.setHeader("Content-Type", "application/json");
          if (request.url === "/api/agents")
            response.end(
              JSON.stringify({
                agents: [{ id: "writer", name: "Research Writer", endpoint: null }],
              }),
            );
          else if (request.url === "/api/plugins/for/writer") {
            eligibilityChecks++;
            response.end(JSON.stringify({ tools: [], skills: [] }));
          } else if (request.url === "/api/host-access") {
            eligibilityChecks++;
            response.end(JSON.stringify({ grants: [], pending: [], connected: false }));
          } else if (request.url === "/api/openmuse/scoped-runs") response.end("{}");
          else response.writeHead(404).end("{}");
        })
      : undefined;
  if (openbot) {
    openbot.listen(0, "127.0.0.1");
    await once(openbot, "listening");
  }
  const address = openbot?.address();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://127.0.0.1:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    intelligenceApiKey: "test-only",
    googleRedirectUri: "http://127.0.0.1:8787/api/google/callback",
    allowedOrigins: [],
    ...(address && typeof address !== "string"
      ? {
          openbotEnabled: true,
          openbotBaseUrl: `http://127.0.0.1:${address.port}`,
          openbotScopedReadRoot: directory,
          ...(scopedReads === true
            ? {
                openbotScopedReadToken: "scoped-bearer",
                openbotScopedReadSigningKey: "test-signing-key-that-is-at-least-32-bytes",
              }
            : {}),
        }
      : {}),
  };
  const server = await createApp(db, config);
  await server.agent.stop();
  const threadId = "routing-chat";
  await db.put("local-user", "conversation-settings", { id: "main", threadId });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
    if (openbot) {
      const closed = once(openbot, "close");
      openbot.close();
      await closed;
    }
  });
  const gateway = server.agent.openbot;
  assert.ok(gateway);
  return {
    ...server,
    db,
    directory,
    requests,
    gateway,
    get eligibilityChecks() {
      return eligibilityChecks;
    },
    conversation: new ConversationAgent(config, server.agent, "local-user"),
    input(text: string): RunAgentInput {
      return {
        threadId,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: "user", content: text }],
        tools: [],
        context: [],
        state: {},
      };
    },
  };
}

async function run(chat: Awaited<ReturnType<typeof fixture>>, text: string) {
  return (await lastValueFrom(chat.conversation.run(chat.input(text)).pipe(toArray()))).map(
    (event) => EventSchemas.parse(event),
  );
}

test("clear specialist fit uses the live eligible roster and creates a named task", async (t) => {
  const chat = await fixture(t, [
    { name: "list_eligible_specialists", arguments: {} },
    {
      name: "delegate_to_bot",
      arguments: { botId: "writer", prompt: "Research this request" },
    },
    undefined,
  ]);
  const bot: Bot = { id: "writer", name: "Research Writer", title: "Research specialist" };
  t.mock.method(chat.gateway, "agents", async () => ({ agents: [bot] }));
  t.mock.method(chat.gateway, "eligibleBot", async (id: string) => {
    assert.equal(id, bot.id);
    return bot;
  });

  const events = await run(chat, "Compare two approaches to organizing research notes");
  const tasks = await chat.db.list<{ kind: string; delegation?: { botId: string } }>(
    "local-user",
    "tasks",
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "openbot");
  assert.equal(tasks[0].delegation?.botId, bot.id);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.ok(chat.requests[0].body.includes("list_eligible_specialists"));
  assert.ok(chat.requests[1].body.includes("Research specialist"));
});

test("an explicit keep-it-here instruction suppresses Bot routing", async (t) => {
  const chat = await fixture(t, [undefined]);
  let rosterCalls = 0;
  t.mock.method(chat.gateway, "agents", async () => {
    rosterCalls++;
    return { agents: [{ id: "writer", name: "Research Writer" }] };
  });

  await run(chat, "Handle this here; do not use a Bot. Give me a short outline.");
  assert.equal(rosterCalls, 0);
  assert.equal((await chat.db.list("local-user", "tasks")).length, 0);
  assert.ok(
    chat.requests[0].body.includes("If the user explicitly says to handle the request here"),
  );
});

test("ties and ineligible stale-grant Bots are returned as choices or omitted", async (t) => {
  const chat = await fixture(t, [
    { name: "list_eligible_specialists", arguments: {} },
    undefined,
    { name: "list_eligible_specialists", arguments: {} },
    undefined,
  ]);
  const bots: Bot[] = [
    { id: "research", name: "Research Bot", title: "Research specialist" },
    { id: "writing", name: "Writing Bot", title: "Writing specialist" },
    { id: "stale", name: "Stale Bot", title: "Research specialist" },
  ];
  let rosterReads = 0;
  t.mock.method(chat.gateway, "agents", async () => ({
    agents: ++rosterReads === 1 ? bots : [bots[2]],
  }));
  t.mock.method(chat.gateway, "eligibleBot", async (id: string) => {
    const bot = bots.find((candidate) => candidate.id === id);
    assert.ok(bot);
    if (id === "stale") throw new Error("effective grants changed");
    return bot;
  });

  const tieEvents = await run(chat, "I need help researching a topic");
  const choice = tieEvents.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(choice && choice.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(choice.content).bots, [
    { id: bots[0].id, name: bots[0].name, role: bots[0].title },
    { id: bots[1].id, name: bots[1].name, role: bots[1].title },
  ]);
  const noFitEvents = await run(chat, "Find a specialist for this task");
  const emptyRoster = noFitEvents.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(emptyRoster && emptyRoster.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(emptyRoster.content).bots, []);
  assert.ok(
    chat.requests[3].body.includes(
      "if none are eligible or eligibility cannot be verified, explain the limitation and continue locally when possible",
    ),
  );
  assert.equal((await chat.db.list("local-user", "tasks")).length, 0);
});

test("named unavailable Bots are not substituted and grants are rechecked at handoff", async (t) => {
  const chat = await fixture(t, [
    {
      name: "delegate_to_bot",
      arguments: { botId: "missing", prompt: "Summarize these notes" },
    },
    undefined,
    { name: "list_eligible_specialists", arguments: {} },
    {
      name: "delegate_to_bot",
      arguments: { botId: "stale", prompt: "Summarize these notes" },
    },
  ]);
  const bot: Bot = { id: "stale", name: "Stale Bot", title: "Research specialist" };
  t.mock.method(chat.gateway, "agents", async () => ({ agents: [bot] }));
  let checks = 0;
  t.mock.method(chat.gateway, "eligibleBot", async (id: string) => {
    checks++;
    if (id === "missing" || checks > 2) throw new Error("Bot unavailable or grants changed");
    return bot;
  });

  const unavailable = await run(chat, "Use the named Bot missing");
  assert.equal(unavailable.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await chat.db.list("local-user", "tasks")).length, 0);
  const staleEvents = await run(chat, "Please research this with the specialist");
  assert.equal(staleEvents.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal((await chat.db.list("local-user", "tasks")).length, 0);
  assert.equal(checks, 3);
});

test("named Bot routing uses scoped reads when verified and a safe excerpt otherwise", async (t) => {
  const calls = [
    {
      name: "delegate_to_bot",
      arguments: {
        botId: "writer",
        prompt: "Summarize garden roses",
        sourcePath: "garden.txt",
      },
    },
    undefined,
  ];
  const scoped = await fixture(t, calls, true);
  const source = [
    "garden roses need sunlight",
    "garden roses PRIVATE_KEY=RELEVANT_SECRET_SENTINEL need shade",
    "unrelated PRIVATE_SENTINEL_COOKIE=keep-out",
    "garden roses need water",
  ].join("\n");
  async function addNamedSource(chat: Awaited<ReturnType<typeof fixture>>) {
    const ownerPath = join(
      chat.directory,
      createHash("sha256").update("local-user").digest("hex").slice(0, 24),
    );
    await mkdir(ownerPath);
    await writeFile(join(ownerPath, "garden.txt"), source);
  }
  await addNamedSource(scoped);
  await run(scoped, "Use Research Writer to summarize garden roses from garden.txt");
  const directTask = (
    await scoped.db.list<{
      delegation?: { readMode?: string; sentContext: string; fallbackExcerpt?: string };
    }>("local-user", "tasks")
  )[0];
  assert.ok(directTask);
  assert.equal(scoped.eligibilityChecks, 2);
  assert.equal(directTask.delegation?.readMode, "direct");
  assert.match(directTask.delegation?.sentContext ?? "", /Resource ID: /);
  assert.doesNotMatch(directTask.delegation?.sentContext ?? "", /garden\.txt/);
  assert.doesNotMatch(directTask.delegation?.sentContext ?? "", /garden roses need sunlight/);
  assert.match(directTask.delegation?.fallbackExcerpt ?? "", /garden roses need sunlight/);
  assert.doesNotMatch(
    directTask.delegation?.fallbackExcerpt ?? "",
    /PRIVATE_SENTINEL|RELEVANT_SECRET_SENTINEL/,
  );

  const fallback = await fixture(t, calls, false);
  await addNamedSource(fallback);
  await run(fallback, "Use Research Writer to summarize garden roses from garden.txt");
  const excerptTask = (
    await fallback.db.list<{ delegation?: { readMode?: string; sentContext: string } }>(
      "local-user",
      "tasks",
    )
  )[0];
  assert.ok(excerptTask);
  assert.equal(excerptTask.delegation?.readMode, "excerpt");
  assert.match(excerptTask.delegation?.sentContext ?? "", /garden roses need sunlight/);
  assert.match(excerptTask.delegation?.sentContext ?? "", /garden roses need water/);
  assert.doesNotMatch(
    excerptTask.delegation?.sentContext ?? "",
    /PRIVATE_SENTINEL|RELEVANT_SECRET_SENTINEL/,
  );
});
