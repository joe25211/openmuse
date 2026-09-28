# OpenMuse agent guidance

## Repository guidance

- For issues and PRs, use the `joe25211/openmuse` fork and follow `docs/agents/issue-tracker.md`; `origin` points to upstream.
- For issue triage, use the label mapping in `docs/agents/triage-labels.md`.
- For code exploration and domain decisions, follow `docs/agents/domain.md` and use the shared vocabulary in `CONTEXT.md`.

## Delegation

Delegate independent, bounded work with a clear scope and done criteria. Keep one writing agent per checkout; the main agent owns integration and final verification. When model overrides are available, use `gpt-6-luna` at high effort with limited inherited history for narrow, read-only scans; use a larger model for implementation or review.

## Code Review Rules

- **OpenBot task boundary:** Native OpenBot channel chat uses OpenBot grants and is separate from durable OpenMuse AgentTask execution. A delegated AgentTask needs an explicit task-to-run link; channel creation or a chat reply does not establish dispatch, recovery, or completion.
- **Reviewed actions:** For delegated AgentTasks, scope browser, computer, file, and shell tools at the server boundary. Execute a persistent external change only after OpenMuse durably approves the exact proposed action; an OpenBot grant alone is insufficient.
- **Uncertain outcomes:** Keep delegated AgentTasks and reviewed Actions nonterminal while a stop or external mutation is unconfirmed. Reconcile the original run or action before retrying; a repeated request must not duplicate a change, and a late result must not overwrite the reconciled state.
