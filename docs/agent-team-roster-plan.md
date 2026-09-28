# Requested agent teams and roster approval

Status: planning recommendation for [issue #9](https://github.com/joe25211/openmuse/issues/9). This does not add team runtime behavior or approve a particular roster.

## Product boundary

A single-Bot delegated task sends one request to one directly selected Bot. A team request proposes multiple named members with distinct responsibilities under one OpenMuse request. Keep it an explicit user request; do not infer a team from ordinary delegation. The first handoff decision already chooses one eligible Bot directly, without a coordinator Bot ([issue #4 resolution](https://github.com/joe25211/openmuse/issues/4#issuecomment-5864021640)).

Represent the work as one parent AgentTask with a fixed roster snapshot and separately tracked member assignments/results. OpenMuse owns the task, coordination, user-visible status, and final answer. Bots do not add members or delegate further unless a later approval explicitly permits that. A one-off roster belongs only to that task. An ongoing team is a saved template of member identities and role intent; each new task must still create a fresh roster snapshot and recheck availability and authority. Saving a template grants no standing task or tool authority.

## Proposed roster and authority review

Show a structured roster before starting:

- Member identity and current role description.
- Assigned responsibility and expected contribution/result.
- Context and named resources each member will receive or read.
- Effective tools and grants relevant to that assignment, in plain language; distinguish scoped read access from anything that can change state.
- What OpenMuse will combine, and whether any result can lead to a separately reviewed action.

Role text is a responsibility label, not a permission. Determine eligibility from effective grants and server-enforced scope. The accepted first-release boundary allows automatic reads only when verified read-only tools are scoped to named resources; otherwise OpenMuse sends selected excerpts. Persistent changes remain proposals for OpenMuse review and execution ([issue #3 resolution](https://github.com/joe25211/openmuse/issues/3#issuecomment-5863598896)). Apply that boundary to every member; a roster is not a way to pool or widen grants.

Approval should bind to the exact roster, roles, task brief, included context/resources, and effective authority shown. Starting is a separate explicit action after review. Reapproval is required if a member, role, task scope, context/resource set, or effective authority changes before or during dispatch. If an approved member becomes unavailable or ineligible, pause and propose a revised roster; never silently substitute. Keep original and replacement rosters visible in task history.

## Interface choice and A2UI

Start with a fixed, accessible roster review card in the OpenMuse conversation: member rows, responsibility, context, effective authority, and clear **Approve and start** / **Edit** actions. The current app already renders known UI components for known tool calls in [chat.tsx](../apps/mobile/src/chat.tsx); no A2UI roster flow is present in this checkout.

A2UI is a JSON protocol for agent-described UI rendered from an application-owned component catalog, with schema validation and user actions ([protocol](https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/docs/a2ui_protocol.md), [project overview](https://github.com/a2ui-project/a2ui/blob/main/README.md)). That could support varied roster presentations across clients, but it adds a protocol, renderer, catalog, and validation surface for a review flow whose fields are already known. It does not establish trustworthy membership or authority: those must come from server records and be revalidated at approval/start. Do not adopt A2UI for the first slice. Reconsider it if OpenMuse needs several agent-generated interactive flows across web and mobile; keep roster values typed and server-validated either way.

## Recommended next slice

After the user resolves the decisions below, implement one-off teams only: request a team, propose a bounded roster, show the structured review card, require approval, then start a parent AgentTask with the approved roster snapshot and per-member progress. Preserve the single-Bot path unchanged. Defer saved ongoing templates, dynamic roster generation, member substitution, and multi-agent coordination policies until the one-off flow demonstrates demand. Do not begin implementation from this plan alone; team execution remains outside the approved single-Bot implementation scope ([issue #12](https://github.com/joe25211/openmuse/issues/12)).

## Decisions still needed from the user

1. Should the first team slice support only one-off tasks, as recommended, or also saved ongoing templates?
2. Should the user pick members, roles, or both, with OpenMuse proposing the remaining fields? What should happen when several eligible members fit a role?
3. Should members run independently in parallel, in a user-visible sequence, or under a coordinator? The recommendation is to defer coordinator behavior and start with independent assignments plus OpenMuse synthesis.
4. Is approval required once for the exact roster and task, or should each member's dispatch also be separately confirmable? Recommendation: one roster approval, with reapproval for any material change described above.
5. What should happen when an approved member becomes unavailable: pause for user choice (recommended) or allow a pre-approved substitute set?
6. What retention and edit rules should apply to saved team templates, if/when they are added?

Issue #9 remains open until these product decisions are resolved.
