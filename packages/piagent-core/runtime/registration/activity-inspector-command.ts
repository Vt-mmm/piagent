import { createHash } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.ts";
import {
  buildActivityInspector,
  formatActivityInspector,
  type ActivityInspectorEvent,
  type CurrentActivity
} from "../product/activity-inspector.ts";
import { formatActivityFooter, formatActivityPanel } from "../product/activity-inspector-footer.ts";
import { adaptActivityTelemetryEvent, runtimeStartedEventDraft } from "../inspection/activity-event-adapter.ts";
import { RuntimeEventStore, type RuntimeEventRevision } from "../inspection/runtime-event-store.ts";
import { WEBUI_RUNTIME_INSTANCE_REF, webUiProjectRef, webUiSessionRef } from "../inspection/webui-snapshot.ts";
import { prefixCompletions, registerRuntimeCommand } from "./extension-registration.ts";

const INSPECTOR_ACTIONS = ["summary", "files", "commands", "security", "context", "toggle", "help"] as const;
const INSPECTOR_SURFACE_KEY = "00-piagent-inspector";
type InspectorAction = typeof INSPECTOR_ACTIONS[number];

type InspectorDependencies = {
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  readEvents: (cwd: string) => ActivityInspectorEvent[];
  selectAction: (
    ctx: ExtensionContext,
    title: string,
    entries: Array<{ value: string; label: string; description?: string; recommended?: boolean }>,
    defaultValue?: string
  ) => Promise<string | undefined>;
  emit: (ctx: ExtensionContext, customType: string, content: string, details?: Record<string, unknown>) => void;
  protectedPaths?: (ctx: ExtensionContext) => string[];
};

function sessionKey(ctx: ExtensionContext): string {
  return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
}

function revisionToken(prefix: string, value: unknown): string {
  return `${prefix}.${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function eventRevision(ctx: ExtensionContext, task?: TaskContract): RuntimeEventRevision {
  return {
    runtimeRevision: revisionToken("runtime-rev", [WEBUI_RUNTIME_INSTANCE_REF, ctx.sessionManager.getSessionId()]),
    taskRevision: task ? revisionToken("task-rev", [task.taskRunId, task.updatedAt, task.trace.outcome]) : null,
    controlRevision: task ? revisionToken("control-rev", [task.taskRunId, task.trace.outcome]) : null,
    workspaceRevision: null,
    indexRevision: null,
    approvalRevision: null,
    sessionOptionRevision: null,
    queueRevision: null
  };
}

function clipped(value: unknown, maximum = 96): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function currentActivity(event: ActivityInspectorEvent): CurrentActivity | undefined {
  const toolCallId = String(event.toolCallId ?? "").trim();
  const toolName = String(event.toolName ?? "").trim();
  if (!toolCallId || !toolName) return undefined;
  const target = clipped(event.targetPath ?? event.command);
  const label = ["edit", "write", "apply_patch"].includes(toolName)
    ? "editing"
    : ["read", "grep", "find", "ls"].includes(toolName)
      ? "reading"
      : ["bash", "shell", "exec"].includes(toolName)
        ? "running"
        : "calling";
  return { toolCallId, toolName, label, target, startedAt: event.recordedAt ?? new Date().toISOString(), status: "running" };
}

function mergeEvents(persisted: ActivityInspectorEvent[], memory: ActivityInspectorEvent[]): ActivityInspectorEvent[] {
  const merged = new Map<string, ActivityInspectorEvent>();
  for (const event of [...persisted, ...memory]) {
    const key = event.activityId ?? [event.event, event.toolCallId, event.recordedAt, event.toolName].join(":");
    merged.set(key, event);
  }
  return [...merged.values()];
}

export function registerActivityInspector(pi: ExtensionAPI, dependencies: InspectorDependencies) {
  const memoryEvents = new Map<string, ActivityInspectorEvent[]>();
  const running = new Map<string, Map<string, CurrentActivity>>();
  const lastActivity = new Map<string, CurrentActivity>();
  const enabled = new Map<string, boolean>();
  const cached = new Map<string, { at: number; view: Awaited<ReturnType<typeof buildActivityInspector>> }>();
  const eventStores = new Map<string, RuntimeEventStore>();

  function eventStore(ctx: ExtensionContext): RuntimeEventStore {
    const key = sessionKey(ctx);
    const existing = eventStores.get(key);
    if (existing) return existing;
    const projectRef = webUiProjectRef(ctx.cwd), sessionRef = webUiSessionRef(ctx.sessionManager.getSessionId());
    const created = new RuntimeEventStore({ projectRoot: ctx.cwd, projectRef, runtimeInstanceId: WEBUI_RUNTIME_INSTANCE_REF, sessionRef });
    eventStores.set(key, created);
    if (!created.resyncRequired() && created.replay(null, 1).lastAvailableSequence === null) {
      const now = new Date().toISOString();
      created.append(runtimeStartedEventDraft({ identity: { projectRef, runtimeInstanceId: WEBUI_RUNTIME_INSTANCE_REF, sessionRef },
        revision: eventRevision(ctx), sourceObservedAt: now, buildRef: "runtime-build.unavailable", capabilitySnapshotRef: "capabilities.inspect-only" }), now);
    }
    return created;
  }

  function sessionEvents(ctx: ExtensionContext): ActivityInspectorEvent[] {
    let persisted: ActivityInspectorEvent[] = [];
    try {
      persisted = dependencies.readEvents(ctx.cwd);
    } catch {
      persisted = [];
    }
    return mergeEvents(persisted, memoryEvents.get(sessionKey(ctx)) ?? []);
  }

  function currentFor(ctx: ExtensionContext): CurrentActivity[] {
    const key = sessionKey(ctx);
    const active = [...(running.get(key)?.values() ?? [])];
    return active.length > 0 ? active : lastActivity.has(key) ? [lastActivity.get(key) as CurrentActivity] : [];
  }

  async function project(ctx: ExtensionContext, force = false) {
    const key = sessionKey(ctx);
    const previous = cached.get(key);
    const current = currentFor(ctx);
    if (!force && previous && Date.now() - previous.at < 400) {
      return { ...previous.view, state: { ...previous.view.state, running: current.filter((activity) => activity.status === "running").length, current } };
    }
    const events = eventStore(ctx);
    const view = await buildActivityInspector({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      task: dependencies.activeTask(ctx),
      events: sessionEvents(ctx),
      sessionEntries: ctx.sessionManager.getBranch(),
      contextUsage: ctx.getContextUsage(),
      current,
      protectedPaths: dependencies.protectedPaths?.(ctx),
      runtimeInstanceId: WEBUI_RUNTIME_INSTANCE_REF,
      eventCursor: events.currentCursor(),
      resyncRequired: events.resyncRequired(),
      eventReplay: events.retention()
    });
    cached.set(key, { at: Date.now(), view });
    return view;
  }

  function clearSurface(ctx: ExtensionContext): void {
    if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(INSPECTOR_SURFACE_KEY, undefined);
    if (typeof ctx.ui?.setWidget === "function") ctx.ui.setWidget("piagent-inspector", undefined);
  }

  async function renderSurface(ctx: ExtensionContext, force = false): Promise<void> {
    if (ctx.mode !== "tui") return;
    const canUseStatus = typeof ctx.ui?.setStatus === "function";
    const canUseWidget = typeof ctx.ui?.setWidget === "function";
    if (ctx.hasUI === false || (!canUseStatus && !canUseWidget)) return;
    const key = sessionKey(ctx);
    if (enabled.get(key) === false) {
      clearSurface(ctx);
      return;
    }
    try {
      const view = await project(ctx, force);
      const color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
      if (canUseWidget) {
        ctx.ui.setWidget("piagent-inspector", formatActivityPanel(view, { color }), { placement: "belowEditor" });
        if (canUseStatus) ctx.ui.setStatus(INSPECTOR_SURFACE_KEY, undefined);
      } else if (canUseStatus) {
        ctx.ui.setStatus(INSPECTOR_SURFACE_KEY, formatActivityFooter(view, { color }));
      }
    } catch {
      if (canUseWidget) {
        ctx.ui.setWidget("piagent-inspector", ["! PIAGENT    state unavailable"], { placement: "belowEditor" });
        if (canUseStatus) ctx.ui.setStatus(INSPECTOR_SURFACE_KEY, undefined);
      } else if (canUseStatus) ctx.ui.setStatus(INSPECTOR_SURFACE_KEY, "! Piagent · state unavailable");
    }
  }

  function observe(ctx: ExtensionContext, payload: ActivityInspectorEvent): void {
    const key = sessionKey(ctx);
    const task = dependencies.activeTask(ctx);
    const event = {
      ...payload,
      sessionId: ctx.sessionManager.getSessionId(),
      taskRunId: payload.taskRunId ?? task?.taskRunId
    };
    const stored = [...(memoryEvents.get(key) ?? []), event].slice(-1_000);
    memoryEvents.set(key, stored);
    try {
      const store = eventStore(ctx);
      const draft = adaptActivityTelemetryEvent({ event, identity: { projectRef: webUiProjectRef(ctx.cwd), runtimeInstanceId: WEBUI_RUNTIME_INSTANCE_REF,
        sessionRef: webUiSessionRef(ctx.sessionManager.getSessionId()), taskId: task?.taskId ?? null, taskRunId: task?.taskRunId ?? null },
      revision: eventRevision(ctx, task) });
      if (draft) store.append(draft);
    } catch {
      // Event replay is an optional projection. Terminal execution remains authoritative.
    }
    let active = running.get(key);
    if (!active) {
      active = new Map();
      running.set(key, active);
    }
    if (event.event === "tool_call") {
      const activity = currentActivity(event);
      if (activity) {
        active.set(activity.toolCallId, activity);
        lastActivity.delete(key);
      }
    }
    if (event.event === "tool_decision" && event.decision === "blocked" && event.toolCallId) {
      const previous = active.get(event.toolCallId);
      active.delete(event.toolCallId);
      if (previous) lastActivity.set(key, { ...previous, label: "blocked", status: "blocked" });
    }
    if (event.event === "tool_result" && event.toolCallId) {
      const previous = active.get(event.toolCallId);
      active.delete(event.toolCallId);
      if (previous) {
        const failed = event.isError === true || (typeof event.exitCode === "number" && event.exitCode !== 0);
        const delta = typeof event.additions === "number" && typeof event.deletions === "number"
          ? ` +${event.additions} -${event.deletions}`
          : "";
        lastActivity.set(key, {
          ...previous,
          label: failed ? "failed" : ["edit", "write", "apply_patch"].includes(previous.toolName) ? "edited" : "completed",
          target: `${previous.target ?? previous.toolName}${delta}`,
          status: failed ? "failed" : "completed"
        });
      }
    }
    cached.delete(key);
    void renderSurface(ctx, event.event === "tool_result" || event.event === "tool_decision");
  }

  function emitHelp(ctx: ExtensionContext): void {
    dependencies.emit(ctx, "piagent-inspector-help", [
      "namespace: /piagent-inspector",
      "/piagent-inspector summary",
      "/piagent-inspector files",
      "/piagent-inspector commands",
      "/piagent-inspector security",
      "/piagent-inspector context",
      "/piagent-inspector toggle",
      "/piagent-inspector --json [summary|files|commands|security|context]",
      "note: the vertical footer panel is automatic and session-local; per-tool model tokens are unavailable by design"
    ].join("\n"), { actions: INSPECTOR_ACTIONS });
  }

  async function chooseAction(ctx: ExtensionContext): Promise<InspectorAction | undefined> {
    const chosen = await dependencies.selectAction(ctx, "Piagent Inspector", [
      { value: "summary", label: "Summary", description: "Task, files, commands, safety, and context", recommended: true },
      { value: "files", label: "Changed files", description: "Task delta, test files, and line counts" },
      { value: "commands", label: "Commands", description: "Executed, failed, blocked, and verifier results" },
      { value: "security", label: "Safety", description: "Policy blocks, redactions, and integrity warnings" },
      { value: "context", label: "Context budget", description: "Live context plus turn and session usage" },
      { value: "toggle", label: "Toggle footer panel", description: "Show or hide the vertical panel beside Pi's native footer for this session" },
      { value: "help", label: "Help", description: "Show the compact command map" }
    ], "summary");
    return INSPECTOR_ACTIONS.includes(chosen as InspectorAction) ? chosen as InspectorAction : undefined;
  }

  registerRuntimeCommand(pi, "piagent-inspector", {
    description: "Inspect task diff, commands, safety, and context budget",
    getArgumentCompletions: (prefix: string) => prefixCompletions([...INSPECTOR_ACTIONS, "--json"], prefix),
    handler: async (raw: string, ctx: ExtensionContext) => {
      const tokens = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
      const json = tokens.includes("--json");
      const actionToken = tokens.find((token) => token !== "--json")?.toLowerCase();
      const action = actionToken
        ? INSPECTOR_ACTIONS.includes(actionToken as InspectorAction) ? actionToken as InspectorAction : undefined
        : await chooseAction(ctx);
      if (!action) {
        if (!actionToken) return;
        dependencies.emit(ctx, "piagent-inspector-error", `Unknown inspector option: ${actionToken ?? "none"}\nRun /piagent-inspector help`, { action: actionToken });
        return;
      }
      if (action === "help") {
        emitHelp(ctx);
        return;
      }
      if (action === "toggle") {
        const key = sessionKey(ctx);
        const next = enabled.get(key) === false;
        enabled.set(key, next);
        await renderSurface(ctx, true);
        ctx.ui.notify(`Piagent Inspector footer panel: ${next ? "on" : "off"}`, "info");
        return;
      }
      const view = await project(ctx, true);
      const content = json ? JSON.stringify({ action, inspector: view }) : formatActivityInspector(view, action);
      dependencies.emit(ctx, `piagent-inspector-${action}`, content, { action, inspector: view });
      void renderSurface(ctx);
    }
  });

  function dispose(ctx: ExtensionContext): void {
    const key = sessionKey(ctx);
    clearSurface(ctx);
    memoryEvents.delete(key);
    running.delete(key);
    lastActivity.delete(key);
    enabled.delete(key);
    cached.delete(key);
    eventStores.delete(key);
  }

  return {
    observe,
    refresh: (ctx: ExtensionContext) => renderSurface(ctx, true),
    project: (ctx: ExtensionContext) => project(ctx, true),
    replay: (ctx: ExtensionContext, afterCursor: string | null, limit?: number) => eventStore(ctx).replay(afterCursor, limit),
    dispose
  };
}
