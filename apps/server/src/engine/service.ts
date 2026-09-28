import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { OpenBotRunObservation } from "../../../../packages/backends/src/openbot.ts";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentMemory,
  type AgentNotification,
  type AgentTask,
  type AgentWorkspace,
  createTaskSchema,
  type Evidence,
  type Goal,
  goalInputSchema,
  type Idea,
  type Monitor,
  monitorInputSchema,
  type RunEvent,
  type TaskDelegation,
} from "../../../../packages/domain/src/agent.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import type { ActionService } from "../actions.ts";
import type { BrowserService } from "../browser.ts";
import type { ComposioService } from "../composio.ts";
import { ComputerService } from "../computer.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import { backgroundFailure } from "../log.ts";
import type { OpenBotGateway } from "../openbot.ts";
import type { WorkspaceService } from "../workspace.ts";
import { analyzeSpending } from "./finance.ts";
import { executeModelTask } from "./model.ts";
import { LostLeaseError, type TaskContext, TaskWorker } from "./worker.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = () => new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "cancelled"]);
const redact = (text: string) =>
  text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bAuthorization\s*:\s*Basic\s+\S+/gi, "Authorization: Basic [redacted]")
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /\b[a-z0-9_]*(?:(?:api|private|access)[\s_-]?key|token|cookie|password|secret|credential)[ \t]*[:=][ \t]*(?:"(?:[^"\\]|\\[\s\S])*(?:"|$)|'(?:[^'\\]|\\[\s\S])*(?:'|$)|[^\r\n]*)/gi,
      "[redacted]",
    );

const unsafeExcerptLine = (line: string) =>
  /(?:^|[^a-z])(?:secret|token|cookie|password|credential|bearer)(?:$|[^a-z])|\b[a-z0-9_]+(?:secret|token|cookie|password|credential|bearer)\s*[:=]|(?:api|private|access)[\s_-]?key|\bAuthorization\s*:|\bBasic\s+[A-Za-z0-9+/=]{12,}|https?:\/\/[^\s/]*@|-----BEGIN/i.test(
    line,
  );

const safeIncludedText = (text?: string) => {
  const safe = text
    ? redact(
        text
          .split(/\r?\n/)
          .filter((line) => !unsafeExcerptLine(line))
          .join("\n")
          .slice(0, 4000),
      ).trim()
    : "";
  return safe || undefined;
};

async function namedText(root: string | undefined, path: string) {
  const parts = path.split(/[\\/]/);
  if (!root || isAbsolute(path) || parts.some((part) => !part || part === "." || part === ".."))
    throw new AppError("This named resource cannot be read safely; supply its text", 422);
  try {
    const base = await realpath(root);
    let current = base;
    for (const part of parts) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error();
    }
    const target = await realpath(resolve(base, path));
    const inside = relative(join(base, parts[0] ?? ""), target);
    if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside))
      throw new Error();
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        (await realpath(`/proc/self/fd/${handle.fd}`)) !== target ||
        !info.isFile() ||
        info.size > 64 * 1024
      )
        throw new Error();
      const bytes = Buffer.alloc(64 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 64 * 1024) throw new Error();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      if (text.includes("\0")) throw new Error();
      return text;
    } finally {
      await handle.close();
    }
  } catch {
    throw new AppError("This named resource cannot be read safely; supply its text", 422);
  }
}

function relevantExcerpt(text: string, request: string) {
  const words = new Set(
    (request.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
      (word) => !["this", "that", "with", "from", "please", "summarize"].includes(word),
    ),
  );
  return redact(
    text
      .split(/\r?\n/)
      .filter(
        (line) =>
          !unsafeExcerptLine(line) && [...words].some((word) => line.toLowerCase().includes(word)),
      )
      .slice(0, 6)
      .join("\n")
      .slice(0, 4000),
  );
}

function sentContext(input: {
  prompt: string;
  brief?: string;
  sourcePath?: string;
  resourcePath?: string;
  excerpt?: string;
  mode?: "direct" | "excerpt" | "supplied";
  conversationId: string;
  requestId: string;
  botId: string;
  runId: string;
}) {
  const context = [
    `Task: ${redact(input.prompt.trim())}`,
    ...(input.brief?.trim() ? [`Relevant brief: ${redact(input.brief.trim())}`] : []),
    ...(input.sourcePath
      ? [
          `Named resource: local text reference (${input.mode === "direct" ? "read-only direct access" : input.mode === "supplied" ? "user-supplied content" : "excerpt only"})`,
        ]
      : []),
    ...(input.mode === "direct" && input.resourcePath
      ? [`Resource ID: ${hash(input.resourcePath).slice(0, 16)}`]
      : []),
    ...(input.excerpt ? [`Included excerpt:\n${input.excerpt}`] : []),
    `Conversation ID: ${input.conversationId}`,
    `Request ID: ${input.requestId}`,
    `Bot ID: ${input.botId}`,
    `Run ID: ${input.runId}`,
  ].join("\n");
  return input.sourcePath ? context.replaceAll(input.sourcePath, "[named resource]") : context;
}
export class AgentService {
  readonly worker: TaskWorker;
  private maintenance?: ReturnType<typeof setInterval>;
  private refreshing = false;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly workspace: WorkspaceService,
    readonly files: Files,
    readonly actions: ActionService,
    readonly browser: BrowserService,
    readonly computer: ComputerService = new ComputerService(db, config),
    readonly composio?: ComposioService,
    readonly openbot?: OpenBotGateway,
    readonly intelligence?: CopilotKitIntelligence,
  ) {
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      settled: (owner, task) => this.publishOutcome(owner, task),
    });
  }
  start() {
    this.worker.start();
    // Maintenance is independent of the HTTP response and reconciles durable records.
    void this.maintain().catch((error) => backgroundFailure("initial maintenance", error));
    this.maintenance = setInterval(() => {
      void this.maintain().catch((error) => backgroundFailure("maintenance", error));
    }, 60000);
  }
  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.worker.stop();
    while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private async maintain() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Recover publications if the process exited after committing an outcome.
      for (const { owner, value } of await this.db.scan<AgentTask>("tasks"))
        await this.publishOutcome(owner, value);
      for (const { owner, value } of await this.db.scan<Monitor>("monitors"))
        await this.activateMonitor(owner, value);
      for (const { owner, value } of await this.db.scan<Idea>("ideas"))
        if (
          value.status === "accepted" &&
          value.taskId &&
          !(await this.db.get(owner, "tasks", value.taskId))
        )
          await this.decideIdea(owner, value.id, "accept").catch(async (error) => {
            backgroundFailure("recover accepted idea", error);
            await this.notify(
              owner,
              "Accepted idea needs attention",
              "Open the idea again after making room for another task.",
              undefined,
              `idea-recovery:${value.id}`,
            );
          });
      for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
        "agent-settings",
      )) {
        if (value.id !== "identity") continue;
        if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
          await this.refreshIdeas(owner).catch(async () => {
            await this.notify(
              owner,
              "Source refresh needs attention",
              "Reconnect the source or refresh Ideas to see the error.",
              undefined,
              `source-error:${Math.floor(Date.now() / 3600000)}`,
            );
          });
      }
    } finally {
      this.refreshing = false;
    }
  }
  async ensure(owner: string) {
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "OpenMuse",
      tone: "warm",
    });
  }
  async snapshot(owner: string): Promise<AgentWorkspace> {
    await this.ensure(owner);
    const [tasks, goals, monitors, ideas, memories, artifacts, notifications, identity] =
      await Promise.all([
        this.db.list<AgentTask>(owner, "tasks"),
        this.db.list<Goal>(owner, "goals"),
        this.db.list<Monitor>(owner, "monitors"),
        this.db.list<Idea>(owner, "ideas"),
        this.db.list<AgentMemory>(owner, "memories"),
        this.db.list<AgentArtifact>(owner, "agent-artifacts"),
        this.db.list<AgentNotification>(owner, "notifications"),
        this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
      ]);
    const heartbeat = await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks");
    return {
      tasks,
      goals,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
      identity: identity ?? { name: "OpenMuse", tone: "warm" },
      worker: {
        running:
          this.worker.running ||
          Boolean(heartbeat && Date.now() - Date.parse(heartbeat.lastTickAt) < 15000),
        lastTickAt: heartbeat?.lastTickAt ?? this.worker.lastTickAt,
      },
    };
  }
  async getTask(owner: string, id: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", id);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  async detail(owner: string, id: string) {
    const task = await this.getTask(owner, id);
    const files = (await this.db.list<Artifact>(owner, "files")).filter((file) =>
      task.artifactIds.includes(file.id),
    );
    const browsers = (await this.db.list<BrowserSession>(owner, "browsers")).filter((browser) =>
      [task.state.browserId, task.state.sessionId].includes(browser.id),
    );
    return {
      task,
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: (await this.db.list<RunEvent>(owner, "run-events"))
        .filter((e) => e.taskId === id)
        .sort((a, b) => a.date.localeCompare(b.date)),
      artifacts: (await this.db.list<AgentArtifact>(owner, "agent-artifacts")).filter(
        (a) => a.taskId === id,
      ),
    };
  }
  async createTask(owner: string, raw: unknown, idempotencyKey?: string, held = false) {
    const input = createTaskSchema.parse(raw);
    if (input.goalId && !(await this.db.get(owner, "goals", input.goalId)))
      throw new AppError("Goal not found", 404);
    const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    if (existing) return existing;
    if (
      (await this.db.list<AgentTask>(owner, "tasks")).filter((t) => !terminal.has(t.status))
        .length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
    const titles =
      input.kind === "document"
        ? [
            "Find the source document",
            "Fill a new copy",
            "Prepare a reply",
            "Wait for your decision",
            "Record the outcome",
          ]
        : input.kind === "monitor"
          ? ["Check the source", "Compare with the last observation", "Report a meaningful change"]
          : input.kind === "finance"
            ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
            : ["Understand the outcome", "Plan the work", "Use connected tools", "Return a result"];
    const task: AgentTask = {
      id,
      title: input.title ?? input.prompt.slice(0, 90),
      prompt: input.prompt,
      kind: input.kind,
      goalId: input.goalId,
      status: held ? "paused" : "queued",
      plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" })),
      evidence: [],
      input: input.input,
      state: {
        connectionId: (await this.workspace.connection(owner))?.id ?? null,
        ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
      },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    await this.ensure(owner);
    await this.db.insertIfAbsent(owner, "tasks", task);
    return (await this.db.get<AgentTask>(owner, "tasks", id)) ?? task;
  }
  async createDelegatedTask(
    owner: string,
    input: {
      conversationId: string;
      requestId: string;
      botId: string;
      prompt: string;
      brief?: string;
      sourcePath?: string;
      suppliedText?: string;
    },
  ) {
    const main = await this.db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (main?.threadId !== input.conversationId) {
      const local =
        input.conversationId === "local-main" ||
        (input.conversationId === "local" &&
          (await this.db.get(owner, "conversations", "default")));
      if (!local) {
        if (!this.intelligence) throw new AppError("Conversation not found", 404);
        try {
          let cursor: string | undefined;
          let found = false;
          do {
            const page = await this.intelligence.listThreads({
              userId: owner,
              agentId: "default",
              ...(cursor ? { cursor } : {}),
            });
            found = page.threads.some(
              (thread) =>
                thread.id === input.conversationId &&
                thread.agentId === "default" &&
                thread.createdById === owner,
            );
            cursor = page.nextCursor ?? undefined;
            if (found) break;
          } while (cursor);
          if (!found) throw new AppError("Conversation not found", 404);
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("Conversation ownership could not be verified", 502);
        }
      }
    }
    const key = `openbot:${input.conversationId}:${input.requestId}`;
    const id = hash(`task:${key}`);
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    const safePrompt = redact(input.prompt.trim());
    const safeBrief = input.brief ? redact(input.brief.trim()) : undefined;
    const resourcePath = input.sourcePath
      ? `${hash(owner).slice(0, 24)}/${input.sourcePath}`
      : undefined;
    const sourceText = resourcePath
      ? await namedText(this.config.openbotScopedReadRoot, resourcePath).catch((error) => {
          if (input.suppliedText) return null;
          throw error;
        })
      : null;
    const sourceExcerpt = sourceText
      ? safeIncludedText(relevantExcerpt(sourceText, `${safePrompt} ${safeBrief ?? ""}`))
      : undefined;
    const fallbackExcerpt = sourceExcerpt || safeIncludedText(input.suppliedText?.trim());
    const mode =
      input.sourcePath &&
      sourceText &&
      this.config.openbotScopedReadToken &&
      this.config.openbotScopedReadSigningKey &&
      this.config.openbotScopedReadSigningKey.length >= 32 &&
      this.config.openbotScopedReadSigningKey !== this.config.openbotScopedReadToken
        ? ("direct" as const)
        : sourceExcerpt
          ? ("excerpt" as const)
          : input.suppliedText
            ? ("supplied" as const)
            : undefined;
    const formatted = (runId: string, botId: string) =>
      sentContext({
        ...input,
        prompt: safePrompt,
        brief: safeBrief,
        botId,
        runId,
        resourcePath,
        mode,
        excerpt: mode === "direct" ? undefined : fallbackExcerpt,
      });
    if (existing) {
      if (
        !existing.delegation ||
        (existing.delegation.botId !== input.botId &&
          existing.delegation.botName.toLowerCase() !== input.botId.toLowerCase()) ||
        existing.prompt !== safePrompt ||
        existing.delegation.brief !== safeBrief ||
        existing.delegation.sourcePath !== input.sourcePath ||
        existing.delegation.resourcePath !== resourcePath ||
        safeIncludedText(existing.delegation.fallbackExcerpt) !== fallbackExcerpt
      )
        throw new AppError("This request already has a different task", 409);
      return existing;
    }
    if (input.suppliedText && !fallbackExcerpt)
      throw new AppError("No safe supplied text was found; remove credentials and try again", 422);
    if (input.sourcePath && !fallbackExcerpt)
      throw new AppError("No relevant excerpt was found; supply the text to include", 422);
    if (!this.openbot) throw new AppError("OpenBot is unavailable", 503);
    const bot = await this.openbot.eligibleBot(input.botId);
    if (
      (await this.db.list<AgentTask>(owner, "tasks")).filter((t) => !terminal.has(t.status))
        .length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
    const runId = randomUUID();
    const task: AgentTask = {
      id,
      title: safePrompt.slice(0, 90),
      prompt: safePrompt,
      kind: "openbot",
      status: "queued",
      plan: [],
      evidence: [],
      input: {},
      state: { connectionId: (await this.workspace.connection(owner))?.id ?? null },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
      delegation: {
        conversationId: input.conversationId,
        requestId: input.requestId,
        botId: bot.id,
        botName: bot.name,
        brief: safeBrief,
        sentContext: formatted(runId, bot.id),
        sourcePath: input.sourcePath,
        resourcePath,
        fallbackExcerpt,
        readMode: mode,
        runId,
        channelAttempted: false,
        submissionAttempted: false,
      },
    };
    await this.ensure(owner);
    await this.db.insertIfAbsent(owner, "tasks", task);
    const latest = await this.getTask(owner, id);
    if (
      !latest.delegation ||
      latest.prompt !== safePrompt ||
      latest.delegation.brief !== safeBrief ||
      latest.delegation.sourcePath !== input.sourcePath ||
      latest.delegation.resourcePath !== resourcePath ||
      latest.delegation.fallbackExcerpt !== fallbackExcerpt ||
      latest.delegation.botId !== bot.id ||
      latest.delegation.conversationId !== input.conversationId
    )
      throw new AppError("This request already has a different task", 409);
    return latest;
  }
  async control(owner: string, id: string, action: "pause" | "resume" | "cancel" | "retry") {
    const task = await this.getTask(owner, id);
    if (task.delegation)
      throw new AppError("Delegated task controls require verified run handling", 409);
    const linked = task.actionId
      ? await this.db.get<ActionProposal>(owner, "actions", task.actionId)
      : null;
    if (linked?.status === "outcome_unknown")
      throw new AppError(
        "This action's outcome is unknown. Check the linked action and connected app before changing this task.",
        409,
      );
    if (linked?.status === "executing")
      throw new AppError(
        "This action may still change the connected app. Check the linked action before changing this task.",
        409,
      );
    if (action === "cancel" && linked?.status === "succeeded")
      throw new AppError("This reviewed action already completed. Check its result first.", 409);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    if (action === "pause" && (terminal.has(task.status) || task.status === "paused")) return task;
    const status =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : task.actionId
            ? "waiting_approval"
            : "queued";
    if (action === "retry" && task.actionId) {
      const a = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (a && a.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before retrying; its outcome may be uncertain. Start a new task when reconciled.",
          409,
        );
    }
    // Claim denial on the Action row before cancelling; approval must lose that same claim.
    if (action === "cancel" && linked?.status === "awaiting_review") {
      const denied = await this.actions.decide(owner, linked.id, linked.hash, "deny");
      if (denied.status !== "denied" && denied.status !== "expired")
        throw new AppError(
          "The reviewed action started; check its outcome before cancelling.",
          409,
        );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      {
        status,
        leaseId: null,
        leaseUntil: null,
        error: null,
        updatedAt: date(),
        result:
          action === "cancel"
            ? "Stopped by you."
            : action === "pause"
              ? task.actionId
                ? "Task paused. A reviewed action may still finish; check it before resuming."
                : "Paused. Resume when you're ready."
              : "",
        ...(task.kind === "monitor" && action === "resume"
          ? { state: { ...task.state, failures: 0, notice: null, resumingMonitor: false } }
          : {}),
      },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    this.worker.abort(id);
    if (task.kind === "monitor")
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        {},
        {
          status: action === "cancel" ? "stopped" : action === "pause" ? "paused" : "active",
          nextCheckAt: date(),
          // Clearing the error fences out a failure reconcile that read the task before this.
          ...(action === "resume" || action === "retry" ? { error: null } : {}),
        },
      );
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: `Task ${status}`,
      detail: "Changed by you",
    });
    return updated;
  }
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    const next = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: "waiting_input" },
      {
        status: "queued",
        question: null,
        input: { ...task.input, ...(fields ? { fields } : {}) },
        state: { ...task.state, answer },
        updatedAt: date(),
      },
    );
    if (!next) throw new AppError("Task changed; refresh and try again", 409);
    return next;
  }
  async createGoal(owner: string, raw: unknown, id?: string) {
    const input = goalInputSchema.parse(raw);
    const goal: Goal = {
      id: id ?? randomUUID(),
      title: input.title,
      description: input.description,
      category: input.category,
      status: "active",
      milestones: input.milestones.map((title) => ({ id: randomUUID(), title, done: false })),
      createdAt: date(),
    };
    await this.db.insertIfAbsent(owner, "goals", goal);
    return (await this.db.get<Goal>(owner, "goals", goal.id)) ?? goal;
  }
  async updateGoal(
    owner: string,
    id: string,
    patch: { status?: Goal["status"]; milestones?: Goal["milestones"] },
  ) {
    const goal = await this.db.get<Goal>(owner, "goals", id);
    if (!goal) throw new AppError("Goal not found", 404);
    const saved = await this.db.put(owner, "goals", { ...goal, ...patch });
    if (patch.status === "paused")
      for (const task of await this.db.list<AgentTask>(owner, "tasks"))
        if (task.goalId === id && !terminal.has(task.status) && task.status !== "paused")
          await this.control(owner, task.id, "pause");
    return saved;
  }
  async createMonitor(owner: string, raw: unknown, idempotencyKey?: string) {
    const input = monitorInputSchema.parse(raw);
    const url = new URL(input.url);
    if (url.protocol === "sample:" && this.config.mode !== "sample")
      throw new AppError("Sample sources are unavailable in live workspaces", 422);
    if (!["https:", "http:", "sample:"].includes(url.protocol) || url.username || url.password)
      throw new AppError("Use a public HTTP(S) page", 422);
    if (url.protocol === "sample:" && input.url !== "sample://availability")
      throw new AppError("Unknown sample source", 422);
    const id = idempotencyKey ? hash(`monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title: input.title,
        prompt: `Watch ${input.url} for ${input.condition}${input.value ? `: ${input.value}` : ""}`,
        input: { monitorId: id },
      },
      `monitor:${id}`,
      true,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      ...input,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  private async activateMonitor(owner: string, monitor: Monitor) {
    if (monitor.status !== "active") return null;
    const task = await this.getTask(owner, monitor.taskId);
    if (task.status !== "paused") return null;
    if (task.state.resumingMonitor)
      return this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "paused", state: { resumingMonitor: true } },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, resumingMonitor: false, failures: 0, notice: null },
        },
      );
    if (!task.state.initializingMonitor) return null;
    return this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "paused", attempts: 0, state: { initializingMonitor: true } },
      {
        status: "queued",
        state: { ...task.state, initializingMonitor: false },
      },
    );
  }
  async controlMonitor(owner: string, id: string, action: "pause" | "resume" | "stop" | "check") {
    const monitor = await this.db.get<Monitor>(owner, "monitors", id);
    if (!monitor) throw new AppError("Monitor not found", 404);
    if (monitor.status === "stopped" && action !== "stop")
      throw new AppError("Create a new watch to restart this stopped monitor", 409);
    if (action === "pause" || action === "stop") {
      const status = action === "pause" ? "paused" : "stopped";
      const saved = await this.db.put(owner, "monitors", {
        ...monitor,
        status,
        nextCheckAt: date(),
      });
      const task = await this.getTask(owner, monitor.taskId);
      await this.control(owner, task.id, action === "pause" ? "pause" : "cancel");
      return saved;
    }
    let monitorStatus = monitor.status;
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = await this.getTask(owner, monitor.taskId);
      if (task.status === "cancelled") break;
      if (task.status === "paused") {
        // Mark the paused task before activating the monitor so no worker can claim it in between.
        const marked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", leaseId: task.leaseId ?? null },
          { state: { ...task.state, resumingMonitor: true } },
        );
        if (!marked) break;
        const activated = await this.db.compareAndSwap<Monitor>(
          owner,
          "monitors",
          id,
          { status: monitor.status },
          { status: "active", nextCheckAt: date(), error: null },
        );
        const saved = activated ?? (await this.db.get<Monitor>(owner, "monitors", id));
        if (saved?.status === "active" && (await this.activateMonitor(owner, saved))) return saved;
        const unmarked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", state: { resumingMonitor: true } },
          { state: { ...task.state, resumingMonitor: false } },
        );
        // Another request or maintenance may have finished this resume first.
        if (!unmarked && saved?.status === "active") {
          const latest = await this.getTask(owner, task.id);
          if (["queued", "running", "scheduled"].includes(latest.status)) return saved;
        }
        if (activated)
          await this.db.compareAndSwap(
            owner,
            "monitors",
            id,
            { status: "active" },
            { status: monitor.status, error: monitor.error ?? null },
          );
        break;
      }
      // Only activate the monitor we read, so a concurrent stop is never undone.
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        { status: monitorStatus },
        { status: "active", nextCheckAt: date() },
      );
      if (!saved) break;
      monitorStatus = "active";
      this.worker.abort(task.id);
      const queued = await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        // updatedAt fences out a whole run finishing in between, which would move the baseline.
        { status: task.status, leaseId: task.leaseId ?? null, updatedAt: task.updatedAt },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, failures: 0, notice: null },
        },
      );
      if (queued) return saved;
    }
    throw new AppError("The watch changed while updating. Try again.", 409);
  }
  async refreshIdeas(owner: string) {
    const w = await this.workspace.snapshot(owner);
    const sentIds = new Set(
      w.mail.filter((mail) => /^Sent\b/i.test(mail.label)).map((mail) => mail.id),
    );
    const completedSources = new Set(
      (await this.db.list<AgentTask>(owner, "tasks"))
        .filter((task) => task.status === "succeeded" && typeof task.input.messageId === "string")
        .map((task) => `${task.kind}:${task.input.messageId}`),
    );
    const obsolete = (kind: AgentTask["kind"], messageId: unknown) =>
      typeof messageId === "string" &&
      (sentIds.has(messageId) || completedSources.has(`${kind}:${messageId}`));
    // Retire earlier suggestions as well as preventing new duplicates. A concurrent
    // acceptance wins its own compare-and-swap and is never overwritten here.
    for (const idea of await this.db.list<Idea>(owner, "ideas"))
      if (idea.status === "new" && obsolete(idea.kind, idea.input.messageId))
        await this.db.compareAndSwap(
          owner,
          "ideas",
          idea.id,
          { status: "new" },
          { status: "dismissed" },
        );
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("document", m.id) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      const id = hash(`document:${mail.id}:${mail.body}`);
      const idea: Idea = {
        id,
        title: `I can help with ${mail.subject}`,
        reason: `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      };
      await this.db.insertIfAbsent(owner, "ideas", idea);
    }
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("agent", m.id) &&
          /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      await this.db.insertIfAbsent(owner, "ideas", {
        id: hash(`coordination:${mail.id}`),
        title: `I can help coordinate ${mail.subject}`,
        reason: `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      } satisfies Idea);
    }
    for (const goal of await this.db.list<Goal>(owner, "goals"))
      if (goal.status === "active" && !goal.milestones.length) {
        const id = hash(`goal:${goal.id}:${goal.description}`);
        await this.db.insertIfAbsent(owner, "ideas", {
          id,
          title: `Let's make a plan for ${goal.title}`,
          reason: "This goal has no milestones yet. A concrete plan will give it a next step.",
          evidence: [{ id: goal.id, kind: "user", title: goal.title, excerpt: goal.description }],
          prompt: `Create an actionable plan for ${goal.title}. ${goal.description}`,
          kind: "plan",
          input: { goalId: goal.id },
          status: "new",
          createdAt: date(),
        } satisfies Idea);
      }
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return this.db.list<Idea>(owner, "ideas");
  }
  async decideIdea(owner: string, id: string, action: "accept" | "dismiss", prompt?: string) {
    let idea = await this.db.get<Idea>(owner, "ideas", id);
    if (!idea) throw new AppError("Idea not found", 404);
    if (idea.status === "dismissed" || (idea.status === "accepted" && action === "dismiss"))
      return idea;
    if (action === "dismiss")
      return this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        { status: "dismissed" },
      );
    if (idea.status === "new") {
      const claimed = await this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        {
          status: "accepted",
          taskId: hash(`task:idea:${id}`),
          prompt: prompt ?? idea.prompt,
        },
      );
      idea = claimed ?? (await this.db.get<Idea>(owner, "ideas", id));
      if (idea?.status !== "accepted") return idea;
    }
    const goal = await this.createGoal(
      owner,
      { title: idea.title, description: idea.reason },
      hash(`idea-goal:${id}`),
    );
    const task = await this.createTask(
      owner,
      {
        title: idea.title,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        goalId: goal.id,
      },
      `idea:${id}`,
    );
    await this.db.compareAndSwap(
      owner,
      "ideas",
      id,
      { status: "new" },
      { status: "accepted", taskId: task.id },
    );
    return this.db.get<Idea>(owner, "ideas", id);
  }
  async notify(owner: string, title: string, body: string, taskId?: string, key?: string) {
    const value: AgentNotification = {
      id: key ? hash(key) : randomUUID(),
      taskId,
      title,
      body,
      createdAt: date(),
      read: false,
    };
    await this.db.insertIfAbsent(owner, "notifications", value);
  }
  mailEvidence(mail: Mail): Evidence {
    return { id: mail.id, kind: "mail", title: mail.subject, excerpt: mail.body.slice(0, 400) };
  }
  async artifact(
    owner: string,
    task: AgentTask,
    kind: AgentArtifact["kind"],
    title: string,
    summary: string,
    data: Record<string, unknown>,
    key: string = kind,
  ) {
    const value: AgentArtifact = {
      id: hash(`${task.id}:${key}`),
      taskId: task.id,
      kind,
      title,
      summary,
      data,
      createdAt: date(),
    };
    await this.db.put(owner, "agent-artifacts", value);
    return value;
  }
  async prepare(
    owner: string,
    task: AgentTask,
    input: ProposalInput,
    key: string,
    context: TaskContext,
  ) {
    await context.guard();
    if (input.kind !== "composio.execute") {
      const connection = await this.workspace.connection(owner);
      if (connection?.id !== task.state.connectionId)
        throw new AppError(
          "Google connection changed during this task. Start a new task using the current account.",
          409,
        );
    }
    const proposal = await this.actions.propose(owner, input, `${task.id}:${key}`, task.id);
    if (proposal.status === "succeeded") return proposal;
    if (proposal.status !== "awaiting_review" && proposal.status !== "executing")
      throw new AppError(
        `Reviewed action ${proposal.status}: ${proposal.error ?? "No further action was taken"}`,
        409,
      );
    try {
      await context.checkpoint({ actionId: proposal.id });
    } catch (error) {
      if (proposal.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
      throw error;
    }
    if (proposal.status === "awaiting_review")
      await context.event(
        "approval",
        proposal.title,
        `Review prepared for ${proposal.account ?? "the connected account"}`,
      );
    return proposal;
  }
  private async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    if (task.delegation) return this.executeDelegation(owner, task, context);
    await context.event(
      "status",
      task.attempts === 1 ? "Started working" : "Resumed work",
      task.prompt,
    );
    if (task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (!action) throw new Error("The linked review could not be found");
      if (action.status === "succeeded") {
        await context.event("result", "Approved action completed", action.result);
        if (task.kind === "document")
          return this.finish(task, context, action.result ?? "Reply completed");
        task = await context.checkpoint({
          state: { ...task.state, approvalResult: action.result },
          actionId: null,
        });
      } else if (action.status === "outcome_unknown") {
        const detail = `Action outcome unknown: ${action.error ?? "The provider did not confirm this change."} Check the connected app and linked action before continuing.`;
        await context.event("error", "Action needs reconciliation", detail);
        return {
          status: "paused",
          error: detail,
          state: {
            ...task.state,
            notice: {
              title: "Action needs reconciliation",
              body: detail,
              key: `action-unknown:${action.id}`,
            },
          },
        };
      } else if (action.status !== "awaiting_review" && action.status !== "executing")
        throw new Error(
          `Reviewed action ${action.status}: ${action.error ?? "No further action was taken"}`,
        );
      else return { status: "waiting_approval" };
    }
    if (task.kind === "document") return this.document(owner, task, context);
    if (task.kind === "monitor") {
      try {
        return await this.observe(owner, task, context);
      } catch (error) {
        if (error instanceof LostLeaseError || context.signal.aborted) throw error;
        await context.guard();
        const failures = Number(task.state.failures ?? 0) + 1;
        // Each streak of failures (after a success or a resume) gets its own alerts.
        const failureStreak = Number(task.state.failureStreak ?? 0) + (failures === 1 ? 1 : 0);
        const detail = error instanceof Error ? error.message : "Page check failed";
        const nextCheckAt = new Date(
          Date.now() + Math.min(60, 2 ** failures) * 60000,
        ).toISOString();
        await this.db.compareAndSwap(
          owner,
          "monitors",
          String(task.input.monitorId),
          { status: "active" },
          { error: detail, nextCheckAt },
        );
        await context.event(
          "error",
          failures >= 5 ? "Watch paused after repeated failures" : "Check failed; retry scheduled",
          detail,
        );
        return {
          status: failures >= 5 ? "paused" : "scheduled",
          error: detail,
          nextRunAt: nextCheckAt,
          state: {
            ...task.state,
            failures,
            resumingMonitor: false,
            failureStreak,
            notice: {
              title: "Watch needs attention",
              body: detail,
              key: `watch-error:${task.id}:${failureStreak}:${failures >= 5 ? "paused" : "retry"}`,
            },
          },
        };
      }
    }
    if (task.kind === "finance") {
      await context.event("step", "Analyzing the imported transactions");
      const csv = z.string().parse(task.input.csv);
      const data = analyzeSpending(csv);
      const artifact = await this.artifact(
        owner,
        task,
        "finance",
        "Spending tracker",
        `${data.count} transactions · ${data.spending.toFixed(2)} spent`,
        data,
      );
      task = await context.checkpoint({
        artifactIds: [artifact.id],
        evidence: [
          {
            id: task.id,
            kind: "user",
            title: "Your transaction CSV",
            excerpt: `${data.count} rows; ${data.period.from} through ${data.period.to}`,
          },
        ],
      });
      return this.finish(task, context, artifact.summary);
    }
    return executeModelTask(this, owner, task, context);
  }
  private async executeDelegation(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const gateway = this.openbot;
    if (!gateway || !task.delegation) throw new Error("OpenBot is unavailable");
    let delegation = task.delegation;
    const now = () => new Date(context.now()).toISOString();
    const save = async (patch: Partial<TaskDelegation>) => {
      const next = await context.checkpoint({ delegation: { ...delegation, ...patch } });
      if (!next.delegation) throw new LostLeaseError();
      delegation = next.delegation;
    };
    const pending = async (lost: boolean): Promise<Partial<AgentTask>> => {
      if (lost && !delegation.transportLostAt) await save({ transportLostAt: now() });
      if (
        delegation.transportLostAt &&
        context.now() - Date.parse(delegation.transportLostAt) >= 5 * 60_000
      )
        return {
          status: "outcome_unknown",
          error: "The original OpenBot run could not be recovered yet. Reconciliation continues.",
          delegation,
        };
      if (
        !delegation.transportLostAt &&
        context.now() - Date.parse(delegation.lastProgressAt ?? task.createdAt) >= 10 * 60_000 &&
        !delegation.delayedAt
      )
        await save({ delayedAt: now() });
      if (task.status === "outcome_unknown") return { status: "outcome_unknown", delegation };
      return { status: "running", error: null, delegation };
    };
    const observe = async (event: OpenBotRunObservation) => {
      if (delegation.terminal || (event.cursor && event.cursor === delegation.replayCursor)) return;
      await save({
        lastProgressAt: now(),
        lastProgress: event.type,
        delayedAt: undefined,
        ...(event.cursor ? { replayCursor: event.cursor } : {}),
        ...(event.messageId
          ? { messageIds: [...new Set([...(delegation.messageIds ?? []), event.messageId])] }
          : {}),
        ...(event.terminal ? { terminal: event.terminal } : {}),
      });
    };
    if (!delegation.submissionAttempted) {
      const safeExcerpt = safeIncludedText(delegation.fallbackExcerpt);
      const safeContext = sentContext({
        prompt: task.prompt,
        brief: delegation.brief,
        sourcePath: delegation.sourcePath,
        resourcePath: delegation.resourcePath,
        excerpt: delegation.readMode === "direct" ? undefined : safeExcerpt,
        mode: delegation.readMode,
        conversationId: delegation.conversationId,
        requestId: delegation.requestId,
        botId: delegation.botId,
        runId: delegation.runId,
      });
      if (delegation.fallbackExcerpt !== safeExcerpt || delegation.sentContext !== safeContext)
        await save({ fallbackExcerpt: safeExcerpt, sentContext: safeContext });
      if (
        (delegation.readMode === "excerpt" || delegation.readMode === "supplied") &&
        !safeExcerpt
      ) {
        if (delegation.channelAttempted && !delegation.threadId) return pending(true);
        return {
          status: "failed",
          error: "No safe named-resource read or excerpt is available",
          delegation,
        };
      }
    }
    if (!delegation.channelAttempted) {
      await gateway.eligibleBot(delegation.botId);
      await save({ channelAttempted: true });
      try {
        const channel = await gateway.createTaskChannel(delegation.botId);
        await save({ channelId: channel.channelId, threadId: channel.threadId });
      } catch (error) {
        if (error instanceof LostLeaseError) throw error;
        return pending(true);
      }
    }
    if (!delegation.threadId) return pending(true);
    if (!delegation.submissionAttempted) {
      try {
        await gateway.eligibleBot(delegation.botId);
      } catch {
        return {
          status: "failed",
          error: "The named Bot is no longer eligible for a text-only task",
          delegation,
        };
      }
      let scopeSecret: string | undefined;
      if (delegation.readMode === "direct") {
        if (!delegation.resourcePath)
          return {
            status: "failed",
            error: "No safe named-resource read or excerpt is available",
            delegation,
          };
        try {
          scopeSecret = await gateway.bindScopedRead(
            owner,
            task.id,
            delegation.botId,
            delegation.threadId,
            delegation.runId,
            delegation.resourcePath,
          );
        } catch (error) {
          if (error instanceof LostLeaseError) throw error;
          if (!delegation.fallbackExcerpt)
            return {
              status: "failed",
              error: "No safe named-resource read or excerpt is available",
              delegation,
            };
          await save({
            readMode: "excerpt",
            sentContext: sentContext({
              prompt: task.prompt,
              brief: delegation.brief,
              sourcePath: delegation.sourcePath,
              resourcePath: delegation.resourcePath,
              excerpt: delegation.fallbackExcerpt,
              mode: "excerpt",
              conversationId: delegation.conversationId,
              requestId: delegation.requestId,
              botId: delegation.botId,
              runId: delegation.runId,
            }),
          });
        }
      }
      try {
        await gateway.eligibleBot(delegation.botId);
      } catch {
        return {
          status: "failed",
          error: "The named Bot is no longer eligible for a text-only task",
          delegation,
        };
      }
      await save({ submissionAttempted: true, lastProgressAt: now() });
      try {
        const run = await gateway.runText(
          delegation.botId,
          delegation.threadId,
          delegation.runId,
          delegation.sentContext,
          () => save({ startupAcknowledged: true, lastProgressAt: now() }),
          context.signal,
          observe,
          scopeSecret,
        );
        if (run.terminal !== "unconfirmed" && !delegation.terminal)
          await save({ terminal: run.terminal, messageIds: run.messageIds });
        if (run.lost) return pending(true);
      } catch (error) {
        if (error instanceof LostLeaseError) throw error;
        return pending(true);
      }
    } else if (!delegation.terminal) {
      try {
        const run = await gateway.reconnectRun(
          delegation.botId,
          delegation.threadId,
          delegation.runId,
          delegation.replayCursor,
          observe,
          context.signal,
        );
        if (run.terminal !== "unconfirmed" && !delegation.terminal)
          await save({ terminal: run.terminal, messageIds: run.messageIds });
        if (run.lost) return pending(true);
      } catch (error) {
        if (error instanceof LostLeaseError) throw error;
        return pending(true);
      }
    }
    if (!delegation.terminal) return pending(false);
    if (delegation.terminal === "error")
      return { status: "failed", error: "The linked OpenBot run reported an error", delegation };
    try {
      const output =
        delegation.output ||
        (await gateway.textResult(
          delegation.botId,
          delegation.threadId,
          delegation.messageIds ?? [],
        ));
      if (!output)
        return {
          status: "failed",
          error: "The linked OpenBot run finished without a usable answer",
          delegation,
        };
      if (!delegation.output) await save({ output });
      await context.event("result", "Bot answered", output);
      return { status: "succeeded", result: output, error: null, delegation };
    } catch (error) {
      if (error instanceof LostLeaseError) throw error;
      return pending(true);
    }
  }
  async finish(task: AgentTask, context: TaskContext, result: string) {
    await context.guard();
    await context.event("result", "Work completed", result);
    return {
      status: "succeeded" as const,
      result,
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" as const })),
    };
  }
  private async publishOutcome(owner: string, saved: AgentTask) {
    // Reconciliation may win after the worker reads the Action but before it checkpoints the task.
    if (saved.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", saved.actionId);
      if (action) await this.actions.syncReconciledTask(owner, action);
    }
    const task = await this.getTask(owner, saved.id);
    if (task.status === "succeeded") {
      await this.notify(
        owner,
        task.title,
        task.result ?? "Work completed",
        task.id,
        `task-done:${task.id}`,
      );
      if (task.goalId) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const goal = await this.db.get<Goal>(owner, "goals", task.goalId);
          if (!goal || goal.milestones.some((m) => m.id === task.id)) break;
          if (
            await this.db.compareAndSwap(
              owner,
              "goals",
              goal.id,
              { milestones: goal.milestones },
              {
                milestones: [...goal.milestones, { id: task.id, title: task.title, done: true }],
              },
            )
          )
            break;
        }
      }
    } else if (task.status === "failed") {
      await this.notify(
        owner,
        "Task needs attention",
        task.error ?? task.title,
        task.id,
        task.delegation ? `task-error:${task.id}` : `task-error:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "outcome_unknown" && task.delegation) {
      await this.notify(
        owner,
        "Outcome unknown",
        "The original Bot run could not be verified yet. OpenMuse is still checking it.",
        task.id,
        `task-unknown:${task.id}`,
      );
    } else if (task.status === "waiting_input") {
      await this.notify(
        owner,
        "Your details are needed",
        task.question ?? task.title,
        task.id,
        `input:${task.id}:${hash(task.question ?? "")}`,
      );
    } else if (task.status === "waiting_approval") {
      await this.notify(
        owner,
        "Ready for your review",
        task.title,
        task.id,
        `review:${task.actionId}`,
      );
    }
    const notice = z
      .object({ title: z.string(), body: z.string(), key: z.string() })
      .safeParse(task.state.notice);
    if ((task.status === "scheduled" || (task.status === "paused" && task.error)) && notice.success)
      await this.notify(owner, notice.data.title, notice.data.body, task.id, notice.data.key);
    // A watch pauses after repeated failures only once that task outcome has committed.
    if (task.kind === "monitor" && task.status === "paused" && task.error)
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        { status: "active", error: task.error },
        { status: "paused" },
      );
  }
  private async document(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    let source = task.state.source as { mail: Mail; fileId: string } | undefined;
    if (!source) {
      const w = await this.workspace.snapshot(owner);
      const mail = w.mail.find((m) => m.id === task.input.messageId);
      if (!mail) throw new Error("Choose a current email with a PDF attachment to start this task");
      const ref = mail.attachments[0];
      if (!ref) throw new Error("This email has no PDF attachment");
      await ctx.guard();
      let file: Artifact;
      try {
        file = await this.files.get(owner, ref);
      } catch (error) {
        if (!(error instanceof AppError && error.status === 404)) throw error;
        file = await this.workspace.importAttachment(owner, ref);
      }
      source = { mail, fileId: file.id };
      task = await ctx.checkpoint({
        state: { ...task.state, source },
        evidence: [this.mailEvidence(mail)],
        plan: task.plan.map((s, i) => ({ ...s, status: i === 0 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Found the document", file.name);
    }
    const fields = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .parse(task.input.fields);
    if (!fields || !Object.keys(fields).length) {
      const file = await this.files.get(owner, source.fileId);
      const names = file.fields
        ?.filter((f) => f.type !== "unsupported")
        .map((f) => f.name)
        .join(", ");
      if (!names)
        throw new Error(
          "This PDF has no supported fillable fields. Open it in Files to review it.",
        );
      return {
        status: "waiting_input",
        question: `Enter the form values you want to use. Supported fields: ${names}. The original PDF will stay intact.`,
        state: {
          ...task.state,
          source,
          missingFields: file.fields?.filter((f) => f.type !== "unsupported"),
        },
      };
    }
    let filledId = typeof task.state.filledId === "string" ? task.state.filledId : undefined;
    if (!filledId) {
      await ctx.guard();
      const filled = await this.files.fill(owner, source.fileId, fields);
      filledId = filled.id;
      task = await ctx.checkpoint({
        state: { ...task.state, source, filledId },
        artifactIds: [filledId],
        plan: task.plan.map((s, i) => ({ ...s, status: i <= 1 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Saved a filled copy", filled.name);
    }
    const input: ProposalInput = {
      kind: "email.send",
      data: {
        to: [source.mail.from],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(source.mail.subject)
          ? source.mail.subject
          : `Re: ${source.mail.subject}`,
        body:
          typeof task.input.reply === "string"
            ? task.input.reply
            : "Hello,\n\nPlease find the completed form attached.\n\nThank you.",
        attachmentIds: [filledId],
        threadId: source.mail.threadId,
        replyToMessageId: source.mail.id,
      },
    };
    const proposal = await this.prepare(owner, task, input, "document-reply", ctx);
    return {
      status: "waiting_approval",
      actionId: proposal.id,
      plan: task.plan.map((s, i) => ({
        ...s,
        status: i < 3 ? "succeeded" : i === 3 ? "waiting" : "pending",
      })),
    };
  }
  private async observe(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "active")
      return { status: monitor.status === "paused" ? "paused" : "cancelled" };
    let observation: { url: string; title: string; text: string; sessionId?: string };
    if (monitor.url === "sample://availability") {
      if (this.config.mode !== "sample") throw new Error("Sample source unavailable");
      const page = await this.db.get<{ text: string }>(owner, "sample-pages", "availability");
      observation = {
        url: monitor.url,
        title: "Sample dinner availability",
        text: page?.text ?? "No tables available. Check again later.",
      };
    } else {
      await ctx.guard();
      observation = await this.browser.observe(
        owner,
        monitor.url,
        typeof task.state.sessionId === "string" ? task.state.sessionId : undefined,
      );
    }
    const text = observation.text.replace(/\s+/g, " ").trim();
    const currentHash = hash(text);
    const previousHash =
      typeof task.state.lastHash === "string" ? task.state.lastHash : monitor.lastHash;
    const matched =
      monitor.condition === "change"
        ? Boolean(previousHash && previousHash !== currentHash)
        : monitor.condition === "contains"
          ? text.toLowerCase().includes(monitor.value.toLowerCase())
          : this.matchesPrice(text, Number(monitor.value));
    const previouslyMatched = Boolean(task.state.matched);
    const shouldNotify = matched && (monitor.condition === "change" || !previouslyMatched);
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    await ctx.guard();
    // Worker lease is checked before each publication; monitor control also invalidates that lease.
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active" },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastHash: currentHash,
        lastValue: text.slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    await ctx.event(
      "observation",
      previousHash ? "Checked for changes" : "Saved the first observation",
      text.slice(0, 1000),
    );
    if (shouldNotify) {
      await ctx.guard();
      await ctx.event("result", "A meaningful change was found", text.slice(0, 500));
    }
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: shouldNotify
        ? "Change found. A notification is ready."
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        sessionId: observation.sessionId,
        lastHash: currentHash,
        resumingMonitor: false,
        matched,
        failures: 0,
        notice: shouldNotify
          ? {
              title: monitor.title,
              body: `Condition met at ${observation.url}: ${text.slice(0, 240)}`,
              key: `monitor:${monitor.id}:${currentHash}`,
            }
          : null,
      },
      error: null,
      evidence: [
        {
          id: monitor.id,
          kind: "web",
          title: observation.title,
          url: observation.url,
          excerpt: text.slice(0, 600),
        },
      ],
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" })),
    };
  }
  private matchesPrice(text: string, threshold: number) {
    const matches = [...text.matchAll(/(?:\$|USD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
    return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
  }
}
