# Spec: Hermes Phone (v1 thin slice)

Status: product direction confirmed — dedicated OpenMuse Android app; implementation in progress

## Confirmed product boundary

OpenMuse is a dedicated Android application. It is not a tab in Hermes Relay, a Relay plugin page, or a replacement name for Relay chat. The Android app provides the OpenMuse interface; Hermes on GPC owns reasoning, tools, memory, and worker dispatch. The existing Relay installation is separate and is not an installation prerequisite. Agent-initiated notifications in the dedicated app remain a required follow-up milestone after the working chat/history vertical slice; foreground polling alone does not meet that requirement.
Branch: `feat/hermes-phone` (base: upstream `main` @ `50b016c`)
Date: 2026-10-25

## Problem Statement

Joe carries an Android phone and runs a Hermes agent on his workstation (GPC) with
tools, skills, a real browser, durable memory, and the ability to dispatch worker
agents. Today the only ways to reach that agent away from the desk are the desktop
app, a terminal, or chat-platform gateways (Telegram etc.). None of them gives a
durable, reviewable, rich personal-assistant surface on the phone: no persistent
conversation list, no inline tool/artifact cards, no approval queue for risky actions,
no visible progress for work that outlives a single reply.

OpenMuse already has that surface: an Expo app for iOS/Android/web with streamed chat,
inline browser/mail/search/PDF cards, a durable task and review layer, and
notifications. But its brain duplicates Hermes: a CopilotKit runtime plus its own model
loop, its own tool implementations, and its own approval model — and upstream now
requires a hosted CopilotKit Intelligence project key in every mode. Two brains means
duplicated context, two tool ecosystems, and two places where an action can be approved.

## Solution

Repurpose OpenMuse as the phone client for the Hermes agent on GPC, and delete the
second brain.

OpenMuse keeps what it is good at — the Expo surface, the cards, durable task and review
records, queueing, notifications. Hermes becomes the only reasoning and tool layer: it
owns the model, the tool loop, skills, memory, the browser on GPC, and worker dispatch.
A new, small bridge service sits between them and translates OpenMuse's existing AG-UI
chat contract into Hermes's existing API-server contract. Neither side's core behavior
changes.

The phone never holds a Hermes credential. The OpenMuse server talks to the bridge; the
bridge talks to Hermes over loopback or the tailnet.

## User Stories

1. As the phone user, I want to open the app and see my recent conversations, so that I can resume yesterday's work instead of re-explaining it.
2. As the phone user, I want to send a message and see the reply stream in token by token, so that the app feels alive rather than frozen behind a spinner.
3. As the phone user, I want to stop a reply mid-flight and keep my draft, so that a wrong direction costs me nothing.
4. As the phone user, I want to send a follow-up while a turn is still running, so that I can correct course without waiting.
5. As the phone user, I want to see which tools the agent is using (browser, terminal, search, mail, files) as inline cards, so that I can tell whether it is actually doing the work.
6. As the phone user, I want to see the argument each tool call was given, so that I can catch a wrong URL, path, or query before the result arrives.
7. As the phone user, I want failed tool calls shown as failures with their error text, so that I am not misled by a cheerful summary.
8. As the phone user, I want the agent to browse on GPC and show me what it found, so that I get real pages rather than a guess.
9. As the phone user, I want to take over the agent's live browser session, so that I can log in or click through something myself.
10. As the phone user, I want to ask the agent to dispatch a worker to do a long job on GPC, so that it keeps working after I lock my phone.
11. As the phone user, I want to see delegated work as a durable task with a status, so that "still running" is visible rather than assumed.
12. As the phone user, I want to be asked before a risky or external action runs, so that nothing irreversible happens without me.
13. As the phone user, I want to approve or deny that action from a card on my phone, so that I do not have to return to the desktop.
14. As the phone user, I want a denied action to be visibly refused and never retried behind my back, so that a "no" means no.
15. As the phone user, I want an action whose outcome Hermes cannot confirm to stay visibly unresolved, so that I am never told a change happened when it did not.
16. As the phone user, I want to see a message when the agent has finished long-running work, so that I do not have to poll.
17. As the phone user, I want to read a conversation's earlier messages after reinstalling the app, so that history lives on GPC rather than only on the device.
18. As the phone user, I want to start a second conversation without losing the first, so that a side question does not derail the main thread.
19. As the phone user, I want to name, fork, or delete a conversation, so that the list stays usable.
20. As the phone user, I want the model and persona to be whatever Hermes is configured with, so that the phone and desktop behave the same way.
21. As the phone user, I want the app to work over my tailnet without exposing anything publicly, so that my assistant is not on the internet.
22. As the phone user, I want a clear, honest error when GPC or Hermes is down, so that I know the difference between "no answer yet" and "broken".
23. As the phone user, I want the app to reconnect to a running turn after I lose signal, so that a tunnel drop does not eat the reply.
24. As the phone user, I want to use the app without creating or paying for a CopilotKit account, so that the whole stack is mine.
25. As the operator, I want the phone's only credential to be a single scoped token, so that losing the phone does not hand over the workstation.
26. As the operator, I want to revoke that token without rebuilding the app, so that rotation is cheap.
27. As the operator, I want to see the bridge's upstream calls in logs without secrets, so that I can debug a stuck turn.
28. As the operator, I want upstream OpenMuse changes to merge cleanly, so that I keep receiving their fixes.
29. As the operator, I want the bridge to fail closed when it cannot reach Hermes, so that the phone never shows a fabricated success.
30. As the operator, I want a single command to start the phone stack (server, bridge, worker), so that running it is not a ritual.

## Implementation Decisions

### Base and what we keep

- The project rebases on upstream `CopilotKit/openmuse` `main`. The pre-repurpose fork state, which carried OpenBot and Composio integration, is preserved only as an archive tag and is not merged. It conflicts with upstream in 14 files and targets a different bot protocol.
- The fork's own diff stays additive. Upstream features we are not using in v1 (E2B desktop computer, Parallel web search, Google OAuth, Ideas, Goals, Tracking, PDF/finance artifacts, the OpenBot adapter) remain in the tree, disabled by configuration, so upstream merges stay cheap. We do not delete them.

### Remove the second brain

- CopilotKit Intelligence is dropped. Its requirement is a configuration policy, not a technical limit: the runtime has a supported self-hosted SSE mode where `intelligence` and Intelligence-only features are omitted. Removing it means making the key optional, constructing the runtime in SSE mode, and dropping Intelligence-only thread naming.
- Rich Threads and Intelligence-backed thread listing go with it. Conversation history moves to Hermes sessions, which already persist sessions and messages on GPC. The phone's conversation list and message history are served by the bridge, not by a hosted vendor.

### The bridge is the only new seam

- One new service owns the whole integration. It exposes an AG-UI HTTP endpoint to the OpenMuse server and speaks Hermes's API-server protocol upstream. It is a separate workspace package/app, not a patch to OpenMuse server internals, so the fork's core stays upstream-shaped.
- Downstream contract (what OpenMuse already speaks): AG-UI run input in, AG-UI event stream out — run start, text message start/content/end, tool call start/args/end/result, custom events, run finished/error, plus run cancellation.
- Upstream contract (what Hermes already serves, verified on the live API server): a streamed chat turn that emits assistant deltas, assistant commentary, tool progress, approval requests, and terminal done/error frames; plus session create/list/read and message history; plus, for the durable path, runs with event streams, approval, steer, stop, and unknown-outcome resolution.
- v1 uses the streamed chat turn, because it carries token deltas, tool progress, and approval requests in one connection. Run-level durability, reconnect, and unknown-outcome reconciliation move to the durable runs API in a later slice. The bridge's upstream client is written behind an interface so that switch is contained.
- Conversation identity: an OpenMuse conversation maps one-to-one to a Hermes session. The bridge derives `om_` plus the first 32 hexadecimal characters of `sha256(threadId)` and creates that session on first use. Do not trust client-supplied Hermes session IDs; retries must preserve conversation identity.
- Credentials: the bridge holds the Hermes bearer key; the phone never sees it. The phone authenticates to the OpenMuse server exactly as it does today. The bridge is not directly reachable from the phone.
- Honest degradation: unreachable Hermes is an error event, never a synthesized reply. Unconfirmed outcomes and refused approvals are surfaced as their own states, matching the vocabulary already used in this repository.

### Rendering on the phone

- OpenMuse's existing cards are keyed by tool name. The bridge emits tool calls under Hermes's real tool names, so the app can keep its native rendering where semantics match (browser navigation and screenshots, mail, search, files, delegation) and fall back to a generic tool card for everything else.
- New card work in v1 is limited to a generic Hermes tool card and a delegation card. Everything else reuses existing renderers.

### Hosting

- The OpenMuse server and the bridge run on GPC, bound to the tailnet. The Android build points at the tailnet host. No public ingress, no cloud dependency beyond what Hermes already uses for inference.
- The device build is an Expo dev client for Android. Web remains available as a development convenience.

### Deliberately not decided here

- Whether approvals live in OpenMuse's existing review records or solely in Hermes. v1 reads approvals from Hermes and renders them; where the durable record of the decision lives is decided in the approvals slice, after the transport is proven.

## Testing Decisions

Good tests here assert externally observable behavior — the bytes and events the bridge produces and consumes — not the internal shape of its translator. Three rules:

- The bridge is tested at its HTTP boundary. A test drives it with AG-UI run input against a fake Hermes server and asserts the resulting AG-UI event sequence. This is the single, highest seam: everything we own in this integration sits behind it.
- Upstream protocol handling is tested with recorded and hand-written SSE fixtures, including the ugly cases the upstream contract actually has: a tool call that errors, a turn that ends without a reply, an approval request mid-stream, a cancelled run, and a connection that dies mid-stream.
- Translator logic is pure and tested without I/O. The event mapping is a pure function of upstream events, so it can be asserted case by case.
- Prior art in this repository: the outbound adapter contract tests that drive an HTTP client against a fake server, the recovery tests that replay an interrupted turn, and the mobile tests that keep platform-independent logic in plain TypeScript modules.
- On the OpenMuse side, the only behavior change is the optional Intelligence key: its tests assert that the server starts without the key and that Intelligence-only features are absent rather than simulated.
- Nothing in this slice tests Hermes internals. Hermes's own suite owns that.

## Out of Scope

- Voice input and replies.
- Push notifications. The first slice surfaces completed work when the app is open.
- Multi-user accounts, sharing, and per-user isolation on the phone.
- E2B desktop sandboxes, Parallel web search, Google OAuth, Ideas, Goals, Tracking, PDF and finance artifacts. They stay in the tree, unused.
- Rebuilding OpenMuse's Activity surface against Hermes runs. That is the approvals slice.
- Porting OpenMuse's own tool implementations to Hermes, or the reverse.
- iOS build and App Store distribution.
- Migrating the archived fork's OpenBot and Composio work.

## Further Notes

- Verified against the live setup on 2026-10-25: Hermes's API server is enabled on GPC at loopback with a bearer key, and OpenMuse upstream is 77 commits ahead of the archived fork, with 487 unit tests passing on this machine on Node 26 / pnpm 11.19.
- The upstream README's promise — "compatible with any agent harness" — is exactly the seam we are using. Upstream already ships an external raw AG-UI agent mode, so the phone side needs no new protocol.
- The archived fork's reviewed-action hardening (fencing a mutation against cancellation, preserving an uncertain outcome, reconciling before retry) remains conceptually relevant, and Hermes's run model already exposes the equivalent operations. If we later want those invariants tested end to end on the phone, they belong to the approvals slice.
