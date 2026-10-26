import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationMode,
  createConversation,
  loadConversationMessages,
  loadConversationPage,
  saveConversationMessages,
  updateConversation,
} from "../src/conversations";

test("Hermes conversations work without Intelligence and new chats use the server id", async () => {
  assert.equal(conversationMode({ provider: "agui", richThreads: false }), "hermes");
  assert.equal(conversationMode({ provider: "openai", richThreads: true }), "cloud");
  assert.equal(conversationMode({ provider: "sample", richThreads: false }), "local");
  const calls: unknown[] = [];
  const api = {
    request: async <T>(...args: unknown[]) => {
      calls.push(args);
      return { id: "om_0123456789abcdef0123456789abcdef", existing: false } as T;
    },
  };
  assert.deepEqual(await createConversation(api, "draft-uuid"), {
    id: "om_0123456789abcdef0123456789abcdef",
    existing: false,
  });
  assert.deepEqual(calls, [["/api/conversations", { id: "draft-uuid" }, "POST"]]);
});

test("Hermes list paginates by server rows and adapts titles without changing custom ids", async () => {
  const calls: unknown[] = [];
  const api = {
    request: async <T>(...args: unknown[]) => {
      calls.push(args);
      return {
        conversations: [
          {
            id: "custom/id",
            title: "Work",
            archived: false,
            updatedAt: "2026-01-01",
            preview: "Hello",
          },
        ],
        hasMore: true,
      } as T;
    },
  };
  const page = await loadConversationPage(api, 20);
  assert.deepEqual(page, {
    threads: [{ id: "custom/id", name: "Work", archived: false }],
    offset: 21,
    hasMore: true,
  });
  assert.deepEqual(calls, [["/api/conversations?limit=20&offset=20"]]);
});

test("rename and archive target the exact encoded id and propagate failures", async () => {
  const calls: unknown[] = [];
  const api = {
    request: async <T>(...args: unknown[]) => {
      calls.push(args);
      return { id: "custom/id", title: "Renamed", archived: true } as T;
    },
  };
  assert.deepEqual(
    await updateConversation(api, "custom/id", { title: "Renamed", archived: true }),
    { id: "custom/id", name: "Renamed", archived: true },
  );
  assert.deepEqual(calls, [
    ["/api/conversations/custom%2Fid", { title: "Renamed", archived: true }, "PATCH"],
  ]);
  const failing = {
    request: async <T>(): Promise<T> => {
      throw new Error("offline");
    },
  };
  await assert.rejects(updateConversation(failing, "same", { archived: false }), /offline/);
  await assert.rejects(createConversation(failing, "draft"), /offline/);
  await assert.rejects(loadConversationPage(failing, 20), /offline/);
});

test("Hermes history loads even empty new chats and is never PUT to local storage", async () => {
  const calls: unknown[] = [];
  const api = {
    request: async <T>(...args: unknown[]) => {
      calls.push(args);
      return { messages: [] } as T;
    },
  };
  assert.deepEqual(await loadConversationMessages(api, "hermes", "custom/id"), []);
  await saveConversationMessages(api, "hermes", []);
  await saveConversationMessages(api, "cloud", []);
  assert.deepEqual(calls, [["/api/conversations/custom%2Fid/messages"]]);
  await loadConversationMessages(api, "local", "ignored");
  await saveConversationMessages(api, "local", []);
  assert.deepEqual(calls.slice(1), [
    ["/api/conversation"],
    ["/api/conversation", { messages: [] }, "PUT"],
  ]);
  const failing = {
    request: async <T>(): Promise<T> => {
      throw new Error("history unavailable");
    },
  };
  await assert.rejects(loadConversationMessages(failing, "hermes", "saved"), /history unavailable/);
});
