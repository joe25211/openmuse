import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { OpenBotGateway } from "../apps/server/src/openbot.ts";

test("OpenBot gateway forwards a channel run without forwarding the OpenMuse session", async () => {
  const requests: { path: string; authorization?: string; cookie?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/me") response.end(JSON.stringify({ user: { id: "dev-local-user" } }));
    else if (request.url === "/api/capabilities")
      response.end(
        JSON.stringify({ mode: "intelligence", durableHistory: true, generativeUi: true }),
      );
    else if (request.url === "/api/channels" && request.method === "POST")
      response.end(
        JSON.stringify({ channel: { id: "channel-1", threadId: "thread-1", agentIds: ["bot-1"] } }),
      );
    else if (request.url === "/api/copilotkit/agent/bot-1/run")
      response.end(JSON.stringify({ connection: "joined" }));
    else response.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const config = {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://127.0.0.1:8787",
      dataDir: "/tmp/openmuse-test",
      agentBackend: "sample",
      googleRedirectUri: "http://127.0.0.1:8787/api/google/callback",
      allowedOrigins: [],
      openbotEnabled: true,
      openbotBaseUrl: `http://127.0.0.1:${address.port}`,
    } satisfies Config;
    const gateway = new OpenBotGateway(config);
    assert.deepEqual(await gateway.probe(), {
      state: "authenticated",
      userId: "dev-local-user",
      mode: "intelligence",
      durableHistory: true,
      generativeUi: true,
    });
    await Promise.all([gateway.probe(), gateway.probe()]);
    assert.equal(requests.filter((request) => request.path === "/api/me").length, 1);
    assert.equal(requests.filter((request) => request.path === "/api/capabilities").length, 1);
    assert.deepEqual(await gateway.createChannel("bot-1"), {
      channelId: "channel-1",
      threadId: "thread-1",
      agentIds: ["bot-1"],
    });
    await assert.rejects(gateway.createChannel("bot-2"), {
      status: 409,
      message:
        "OpenBot may have created this conversation. Refresh conversations before trying again.",
    });
    const response = await gateway.runtime(
      new Request("http://127.0.0.1:8787/api/openbot/copilotkit/agent/bot-1/run", {
        method: "POST",
        headers: {
          Authorization: "Bearer openmuse-session",
          Cookie: "private=1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: "thread-1" }),
      }),
      "agent/bot-1/run",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connection: "joined" });
    assert.deepEqual(requests.at(-1), {
      path: "/api/copilotkit/agent/bot-1/run",
      authorization: undefined,
      cookie: undefined,
      body: JSON.stringify({ threadId: "thread-1" }),
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
