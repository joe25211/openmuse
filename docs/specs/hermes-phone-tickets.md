# Hermes Phone v1 — ticket breakdown

Spec: [`hermes-phone.md`](./hermes-phone.md). Target repo for issues: `joe25211/openmuse`.
Labels: `ready-for-agent` (see `docs/agents/triage-labels.md`).

Dependency edges are GitHub-native (`blocked_by`). The executable frontier is every
ticket with no open blocker and no assignee.

## Graph

```
T1 self-hosted runtime   ─┐
                          ├─→ T3 bridge translation ─┬─→ T4 session mapping ─→ T5 mobile history
T2 bridge AG-UI scaffold ─┘                         ├─→ T6 wire server ─→ T8 android on tailnet
                                                    └─→ T7 tool cards ─┬─→ T9 approvals
                                                                       └─→ T10 delegation
```

Frontier: **T1, T2**.

---

## T1 — Drop the CopilotKit Intelligence requirement (self-hosted SSE runtime)

**Goal.** The server boots and serves chat with no `CPK_INTELLIGENCE_API_KEY` and makes
no Intelligence call, keeping every other upstream behavior intact.

**Why.** Upstream now hard-requires a hosted key in every mode. The runtime has a
supported self-hosted SSE mode (`intelligence` omitted), so this is a policy removal,
not a rewrite.

**Acceptance**
- Server starts with the key absent and in sample mode.
- The CopilotKit handler still mounts and answers in SSE mode.
- Nothing sets `generateThreadNames`, Channels, or any Intelligence option.
- `.env.example` and the contributor docs no longer instruct anyone to run the CopilotKit CLI.
- Failure message for a genuinely missing *model* configuration still names that cause.

**Tests.** Extend the config suite: config builds without the key; a handler-level test
shows the SSE runtime mounts. Do not mock Intelligence internals.

**Notes.** This unblocks every other ticket and is the smallest one. Do it first.

---

## T2 — Scaffold the bridge app with its AG-UI HTTP contract

**Goal.** A new workspace app exposes an AG-UI endpoint that can be driven end to end
against a fake upstream, with no Hermes involved yet.

**Acceptance**
- The bridge accepts an AG-UI run input and returns an AG-UI event stream.
- It has a health endpoint that reports upstream reachability separately from its own liveness.
- It refuses requests without its bearer token, with a 401 and no detail leak.
- Its upstream base URL, token, and port come from configuration, never from the request.
- `pnpm typecheck` and the new tests run from the repo root like every other app.

**Tests.** Drive the HTTP boundary: assert the event sequence for a trivial turn, a 401
without a token, and a health response when upstream is down versus up.

**Notes.** The upstream client is an interface from day one so T3 can swap implementations
and the durable runs API can replace the streamed chat turn later without touching callers.

---

## T3 — Hermes upstream client and event translation

**Goal.** The bridge turns a real Hermes streamed chat turn into faithful AG-UI events:
text deltas, tool calls with arguments and results, approvals as custom events, and
terminal success or error.

**Acceptance**
- Assistant deltas become text content in order, with no duplicated or dropped tokens.
- Tool progress becomes tool-call start/args/end/result, keeping the tool name and the
  upstream call id stable across start and completion.
- A failed tool call is a completed tool call carrying an error, not a silent success.
- A turn that ends with no assistant text still terminates the run cleanly.
- An upstream error frame becomes a run error carrying a readable message, never a
  fabricated reply.
- Cancelling the run aborts the upstream request and closes the stream promptly.
- A stream that dies mid-flight becomes a run error, not a hang.

**Tests.** Fixture-driven, one case per acceptance bullet, using recorded SSE. Assert
the emitted AG-UI sequence, not internal translator state.

**Blocked by** T2.

---

## T4 — Conversation identity and history

**Goal.** An OpenMuse conversation maps to one Hermes session, and history is served from
there.

**Acceptance**
- First run in a new conversation creates the upstream session and persists the mapping.
- A second run reuses it; a replayed run does not create a duplicate session.
- Listing conversations returns recent sessions with a stable id and a preview.
- Reading history returns prior messages in order, including after a restart.
- An unknown conversation id is a clear 404, not an empty success.

**Tests.** Integration against the fake upstream, plus a restart case proving the mapping
survives.

**Blocked by** T3.

---

## T5 — Mobile: history and conversation list without Intelligence

**Goal.** The app lists conversations and reads history from the bridge instead of the
vendored threads hook, with the existing selection UX unchanged.

**Acceptance**
- The conversation list renders what the bridge returns, newest first.
- Selecting a conversation loads its messages before the composer is usable.
- An empty history is an empty state, not an error or a spinner forever.
- A failed history load is retryable and does not discard the user's draft.
- No code path references Intelligence-backed threads.

**Tests.** Keep platform-independent logic in plain TypeScript modules and test those,
following the existing mobile test layout.

**Blocked by** T4.

---

## T6 — Wire the OpenMuse server to the bridge

**Goal.** Chat in the app is served by Hermes through the bridge, using upstream's
external agent mode.

**Acceptance**
- With the external-agent backend selected, a phone message reaches Hermes and its reply streams back.
- The phone never receives the upstream Hermes credential.
- Configuration is documented in `.env.example` with a safe local default.
- If the bridge is down, the app shows an honest unavailable state rather than an empty reply.
- Sample mode still works untouched for contributors.

**Tests.** Assert the server selects the external backend from config and surfaces an
unavailable state when the bridge is unreachable.

**Blocked by** T3.

---

## T7 — Tool cards for Hermes tool names

**Goal.** Tool activity from Hermes renders as the same kinds of cards the app already has.

**Acceptance**
- Browser, mail, search, and file tools render with their existing card styles.
- Every other tool renders a generic card showing name, arguments, result, and duration.
- A long result is truncated in the card but retrievable.
- Unknown tool names never crash the transcript.

**Tests.** Pure mapping functions, one case per mapped family plus an unknown-name case.

**Blocked by** T3.

---

## T8 — Android dev client on the tailnet

**Goal.** The app runs on the phone against GPC over the tailnet, with one documented start path.

**Acceptance**
- The server and bridge listen only on the tailnet interface, never a public one.
- The Android build points at the tailnet host and connects without a code edit.
- A documented single command brings up server, bridge, and worker.
- The device flow is recorded in the repo docs, including the token-rotation step.

**Tests.** No new unit tests; the evidence is a device smoke with the transcript attached.

**Blocked by** T6.

---

## T9 — Approvals from the phone (follow-up slice)

**Goal.** A risky action pauses in Hermes, appears as a card on the phone, and is executed
only on an explicit approval.

**Acceptance**
- An approval request mid-stream renders as a reviewable card naming the exact action.
- Approving executes it exactly once; the receipt is visible afterward.
- Denying leaves the action refused and never retried by a later turn.
- An action whose outcome cannot be confirmed stays visibly unresolved and is never
  reported as done.
- A stale approval for a finished run cannot be replayed.

**Tests.** Fixture-driven on the bridge; the four invariants above get one test each.
Reuse the repository's existing recovery-test style.

**Blocked by** T3, T7.

---

## T10 — Delegated worker visibility (follow-up slice)

**Goal.** Work dispatched to GPC workers is visible as durable progress, not a spinner.

**Acceptance**
- A delegation tool call renders as a task card with its worker and objective.
- Status changes update in place rather than appending duplicates.
- Completion and failure both surface, with the failing reason visible.
- A disappeared or unreadable status is shown as unknown, not as success.

**Tests.** Pure reducers over status events, following the existing task-card test style.

**Blocked by** T7.
