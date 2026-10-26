import assert from "node:assert/strict";
import test from "node:test";
import { builtinInfrastructureVisible, computerStatus } from "../src/computer-status.ts";

test("external Hermes chat does not advertise the unused built-in worker or computer", () => {
  assert.equal(builtinInfrastructureVisible("agui"), false);
  assert.equal(builtinInfrastructureVisible("sample"), true);
  assert.equal(builtinInfrastructureVisible("model"), true);
});

test("the computer status says offline before anything else", () => {
  assert.equal(computerStatus(false, 0), "offline");
  assert.equal(computerStatus(false, 2), "offline");
  assert.equal(computerStatus(true, 0), "ready");
  assert.equal(computerStatus(true, 1), "take control");
});
