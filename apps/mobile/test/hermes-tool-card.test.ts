import assert from "node:assert/strict";
import test from "node:test";
import { hermesToolResult, legacyToolCard } from "../src/hermes-tool-card.ts";

test("a failed Hermes preview displays Failed and the error preview", () => {
  assert.deepEqual(
    hermesToolResult(
      JSON.stringify({ preview: "Permission denied", failed: true, fullOutputAvailable: false }),
      false,
    ),
    { status: "Failed", result: "Permission denied" },
  );
});

test("only an explicitly successful, attributable preview is Completed", () => {
  for (const [failed, unattributable, status] of [
    [false, false, "Completed"],
    [null, false, "Result unavailable"],
    [false, true, "Result unavailable"],
  ] as const) {
    assert.deepEqual(
      hermesToolResult(
        JSON.stringify({
          preview: "Tool output",
          failed,
          fullOutputAvailable: false,
          unattributable,
        }),
        false,
      ),
      { status, result: "Tool output" },
    );
  }
});

test("Hermes never invokes a legacy renderer, even for overlapping tool names", () => {
  for (const name of ["search", "delegate_task", "search_mail"]) {
    assert.equal(
      legacyToolCard("hermes", () => {
        assert.fail(`legacy renderer invoked for ${name}`);
      }),
      undefined,
    );
  }
});

test("cloud and local/sample keep their named renderer results", () => {
  for (const mode of ["cloud", "local"]) {
    const card = { name: "legacy search card" };
    assert.equal(
      legacyToolCard(mode, () => card),
      card,
    );
  }
});

test("missing results distinguish active calls from calls without a result", () => {
  assert.deepEqual(hermesToolResult(undefined, true), { status: "Working…", result: undefined });
  assert.deepEqual(hermesToolResult(undefined, false), {
    status: "No result received",
    result: undefined,
  });
});

test("unknown attribution never assigns success or failure to a tool", () => {
  for (const failed of [true, false, null]) {
    assert.deepEqual(
      hermesToolResult(
        JSON.stringify({
          preview: "Parallel tool output cannot be attributed",
          failed,
          fullOutputAvailable: false,
          attributionUnknown: true,
        }),
        false,
      ),
      { status: "Unknown", result: "Parallel tool output cannot be attributed" },
    );
  }
});

test("raw and malformed results remain readable without claiming success", () => {
  for (const content of [
    "plain output",
    "",
    "{invalid",
    "null",
    '{"error":"denied"}',
    '{"preview":"partial","failed":false}',
    '{"preview":"partial","failed":"false","fullOutputAvailable":false}',
  ]) {
    assert.deepEqual(hermesToolResult(content, true), {
      status: "Result unavailable",
      result: content,
    });
  }
});
