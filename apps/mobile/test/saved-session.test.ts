import assert from "node:assert/strict";
import test from "node:test";
import { restoreSavedSession, sessionStorageKey } from "../src/saved-session.ts";

function storage(value: string | null) {
  let saved = value;
  return {
    getItemAsync: async (_key: string) => saved,
    deleteItemAsync: async (_key: string) => {
      saved = null;
    },
    value: () => saved,
  };
}

test("a valid saved session resumes without the workspace access key", async () => {
  const store = storage("session-token");
  assert.equal(
    await restoreSavedSession(store, "key", async (token) => token === "session-token"),
    "session-token",
  );
  assert.equal(store.value(), "session-token");
});

test("expired sessions are removed instead of trapping the app in an unauthorized workspace", async () => {
  const store = storage("expired");
  assert.equal(await restoreSavedSession(store, "key", async () => false), null);
  assert.equal(store.value(), null);
});

test("a network outage preserves the saved credential for a later retry", async () => {
  const store = storage("valid");
  await assert.rejects(
    restoreSavedSession(store, "key", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(store.value(), "valid");
});

test("an empty secure store does not attempt authenticated requests", async () => {
  assert.equal(
    await restoreSavedSession(storage(null), "key", async () =>
      assert.fail("unexpected validation"),
    ),
    null,
  );
});

test("secure storage keys are scoped to the exact backend URL", () => {
  const one = sessionStorageKey("https://one.example:8788");
  assert.match(one, /^[a-zA-Z0-9._-]+$/);
  assert.notEqual(one, sessionStorageKey("https://two.example:8788"));
  assert.notEqual(one, sessionStorageKey("http://one.example:8788"));
});
