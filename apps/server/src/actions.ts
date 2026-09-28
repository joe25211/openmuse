import { createHash, randomUUID } from "node:crypto";
import type { AgentTask } from "../../../packages/domain/src/agent.ts";
import {
  type ActionProposal,
  type CalendarEvent,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

type ComposioAction = Extract<ProposalInput, { kind: "composio.execute" }>;
interface Options {
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string) => Promise<boolean>;
  connection?: (owner: string) => Promise<{ id: string; account: string } | null>;
  composio?: {
    connection: (owner: string, input: ComposioAction) => Promise<{ id: string; account: string }>;
    execute: (owner: string, input: ComposioAction, connectionId?: string) => Promise<string>;
  };
  now?: () => number;
}
export class ActionService {
  private readonly now: () => number;
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
  ): Promise<ActionProposal> {
    const id =
      idempotencyKey === undefined
        ? randomUUID()
        : createHash("sha256").update(idempotencyKey).digest("hex");
    if (idempotencyKey !== undefined) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (existing) return existing;
    }
    const parsed = proposalSchema.parse(raw);
    const composio = parsed.kind === "composio.execute";
    const connection = composio
      ? await this.options.composio?.connection(owner, parsed)
      : await this.options.connection?.(owner);
    if (composio && !this.options.composio) throw new AppError("Composio is not configured", 503);
    if (!composio && this.options.connection && !connection)
      throw new AppError("Connect Google before preparing an action", 409);
    const prepared = composio
      ? undefined
      : await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "composio.execute"
        ? `Run ${input.data.tool} in ${input.data.toolkit}`
        : input.kind === "email.send"
          ? `Send “${input.data.subject}”`
          : input.kind === "calendar.delete"
            ? `Delete ${input.data.title}`
            : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const createdAt = new Date(this.now()).toISOString();
    const proposal: ActionProposal = {
      id,
      taskId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved =
      idempotencyKey === undefined
        ? await this.db.put(owner, "actions", proposal)
        : await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      return existing;
    }
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review") return proposal;
    if (decision === "approve" && proposal.taskId) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
    }
    if (decision === "approve" && Date.parse(proposal.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    const input = proposalSchema.parse({ kind: proposal.kind, data: proposal.data });
    if (
      decision === "approve" &&
      input.kind !== "composio.execute" &&
      !(await this.options.connected(owner))
    )
      throw new AppError("Google is disconnected. Reconnect before approving this action.", 409);
    if (decision === "approve" && (input.kind === "composio.execute" || this.options.connection)) {
      const connection =
        input.kind === "composio.execute"
          ? await this.options.composio?.connection(owner, input)
          : await this.options.connection?.(owner);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        throw new AppError(
          "Account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const claimed =
      decision === "deny"
        ? await this.db.compareAndSwap<ActionProposal>(
            owner,
            "actions",
            id,
            { status: "awaiting_review", hash },
            { status: "denied" },
          )
        : await this.db.claim<ActionProposal>(
            owner,
            id,
            "executing",
            new Date(this.now()).toISOString(),
          );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    await this.record(
      owner,
      claimed,
      decision === "deny" ? "Declined; no changes made" : "Approved; execution started",
    );
    if (decision === "deny") return claimed;
    let finished: ActionProposal;
    try {
      let result: string;
      if (input.kind === "composio.execute") {
        if (!this.options.composio) throw new AppError("Composio is not configured", 503);
        result = await this.options.composio.execute(owner, input, claimed.connectionId);
      } else
        result = await this.options.execute(
          owner,
          input,
          claimed.connectionId,
          claimed.targetVersion,
        );
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    const saved = await this.db.compareAndSwap<ActionProposal>(
      owner,
      "actions",
      id,
      { status: "executing", hash: claimed.hash },
      {
        status: finished.status,
        ...(finished.result ? { result: finished.result } : {}),
        ...(finished.error ? { error: finished.error } : {}),
      },
    );
    if (!saved) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    await this.record(owner, saved, saved.result ?? saved.error ?? saved.status);
    return saved;
  }
  async reconcile(
    owner: string,
    id: string,
    hash: string,
    outcome: "completed" | "not_completed",
    note: string,
  ): Promise<ActionProposal> {
    const verifiedNote = note.trim();
    if (verifiedNote.length < 8 || verifiedNote.length > 1000)
      throw new AppError("Describe what you verified in 8 to 1000 characters", 422);
    const action = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!action) throw new AppError("Action not found", 404);
    if (action.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    const confirmedAt = new Date(this.now()).toISOString();
    const completed = outcome === "completed";
    if (
      action.status !== "outcome_unknown" &&
      (action.reconciliation?.outcome !== outcome || action.reconciliation.note !== verifiedNote)
    )
      throw new AppError("Only an action with an unknown outcome can be reconciled", 409);
    const resolved =
      action.status === "outcome_unknown"
        ? await this.db.compareAndSwap<ActionProposal>(
            owner,
            "actions",
            id,
            { status: "outcome_unknown", hash },
            {
              status: completed ? "succeeded" : "failed",
              ...(completed
                ? { result: "You confirmed this action completed in the connected app." }
                : {}),
              error: completed
                ? null
                : "You confirmed this action did not complete. Start a new task if you still want this change.",
              reconciliation: { outcome, note: verifiedNote, confirmedAt },
            },
          )
        : action;
    if (!resolved) throw new AppError("Action changed; refresh before reconciling", 409);
    await this.syncReconciledTask(owner, resolved);
    if (action.status === "outcome_unknown")
      await this.record(
        owner,
        resolved,
        `You confirmed ${completed ? "completed" : "not completed"}: ${verifiedNote}`,
      );
    return resolved;
  }
  async syncReconciledTask(owner: string, action: ActionProposal): Promise<void> {
    if (!action.taskId || !action.reconciliation) return;
    const task = await this.db.get<AgentTask>(owner, "tasks", action.taskId);
    if (task?.actionId !== action.id || !["paused", "waiting_approval"].includes(task.status))
      return;
    const completed = action.reconciliation.outcome === "completed";
    if (completed && task.error == null && task.state.notice == null) return;
    await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      task.id,
      { actionId: action.id, status: task.status, leaseId: task.leaseId ?? null },
      {
        ...(completed ? {} : { status: "failed" }),
        error: completed ? null : action.error,
        state: { ...task.state, notice: null },
        updatedAt: new Date(this.now()).toISOString(),
      },
    );
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
