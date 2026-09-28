import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerService } from "../apps/server/src/computer.ts";
import { computerInstructions, computerTools } from "../apps/server/src/computer-tools.ts";
import type { Store } from "../apps/server/src/db.ts";
import type { Files } from "../apps/server/src/files.ts";
import { config, fixture } from "./helpers/computer.ts";

test("host-backed workspaces expose no agent computer tools; private volumes retain them", () => {
  const f = fixture();
  const db = {} as Store;
  const files = {} as Files;
  const host = new ComputerService(db, { ...config, computerHostDir: "/host-workspace" }, f.runner);
  const volume = new ComputerService(db, config, f.runner);
  assert.deepEqual(computerTools(host, files, "owner", "task:1"), []);
  assert.match(computerInstructions(host), /unavailable/);
  assert.ok(
    computerTools(volume, files, "owner", "task:1").some(
      (tool) => tool.name === "run_computer_command",
    ),
  );
  assert.match(computerInstructions(volume), /private named volume/);
  assert.equal(f.calls.length, 0);
});
