import type { AgentTask } from "../../../packages/domain/src/agent";

export type DelegatedPane = "chat" | "task";

export function paneAfterHorizontalGesture(
  dx: number,
  dy: number,
  current: DelegatedPane,
): DelegatedPane {
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return current;
  return dx < 0 ? "task" : "chat";
}

export function delegatedTaskStatus(task: Pick<AgentTask, "status" | "delegation">): string {
  // #18 adds its persisted Stop unconfirmed marker through this display seam.
  if (task.status === "outcome_unknown") return "Outcome unknown";
  if (task.status === "succeeded") return "Completed";
  if (task.status === "failed") return "Failed";
  if (task.status === "waiting_input") return "Needs your input";
  if (task.status === "waiting_approval") return "Ready for review";
  if (
    task.status === "running" &&
    task.delegation &&
    "delayedAt" in task.delegation &&
    typeof task.delegation.delayedAt === "string" &&
    task.delegation.delayedAt
  )
    return "Taking longer than usual";
  if (task.status === "running") return "In progress";
  return task.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
