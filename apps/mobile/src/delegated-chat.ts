import type { AgentTask } from "../../../packages/domain/src/agent";

export type DelegatedPane = "chat" | "task";

export function freshestTask(task: AgentTask, detail?: AgentTask) {
  return detail?.id === task.id && detail.updatedAt > task.updatedAt ? detail : task;
}

export function taskForConversation(tasks: AgentTask[], conversationId: string) {
  return [...tasks]
    .filter((task) => task.delegation?.conversationId === conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function paneAfterHorizontalGesture(
  dx: number,
  dy: number,
  current: DelegatedPane,
): DelegatedPane {
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return current;
  return dx < 0 ? "task" : "chat";
}

export function delegatedTaskStatus(task: Pick<AgentTask, "status" | "delegation">): string {
  if (task.status === "succeeded") return "Completed";
  if (task.status === "failed") return "Failed";
  if (task.delegation?.stop === "pending" || task.delegation?.stop === "unconfirmed")
    return "Stop unconfirmed";
  if (task.status === "outcome_unknown") return "Outcome unknown";
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

export function delegatedTaskNotice(
  task: Pick<AgentTask, "status" | "delegation" | "question">,
): string {
  const bot = task.delegation?.botName;
  if (task.status === "failed") return `${bot} reported a failure.`;
  if (task.status === "succeeded") return `${bot} finished. The saved result is in Task.`;
  if (task.delegation?.stop === "pending" || task.delegation?.stop === "unconfirmed")
    return "Stop unconfirmed. OpenMuse is checking the original Bot run.";
  if (task.status === "cancelled")
    return task.delegation?.submissionAttempted
      ? "Bot stop confirmed. Started external changes may remain."
      : "Cancelled before Bot submission.";
  if (task.status === "outcome_unknown") return `OpenMuse cannot confirm whether ${bot} finished.`;
  if (task.status === "waiting_input")
    return `${bot} needs your input: ${task.question || "Open the task to continue."}`;
  return `${bot} is working on this task.`;
}
