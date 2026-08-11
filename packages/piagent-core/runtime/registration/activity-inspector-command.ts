import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.ts";
import {
  buildActivityInspector,
  formatActivityInspector,
  inspectWorkingTreeFiles,
  type ActivityInspectorEvent,
  type CurrentActivity
} from "../product/activity-inspector.ts";
import { formatActivityFooter, formatActivityPanel } from "../product/activity-inspector-footer.ts";
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
};

function sessionKey(ctx: ExtensionContext): string {
  return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
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
  const cached = new Map<string, { at: number; view: ReturnType<typeof buildActivityInspector> }>();

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

  function project(ctx: ExtensionContext, force = false, exactFiles = false) {
    const key = sessionKey(ctx);
    const previous = cached.get(key);
    const current = currentFor(ctx);
    if (!exactFiles && !force && previous && Date.now() - previous.at < 400) {
      return { ...previous.view, state: { ...previous.view.state, running: current.filter((activity) => activity.status === "running").length, current } };
    }
    const view = buildActivityInspector({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      task: dependencies.activeTask(ctx),
      events: sessionEvents(ctx),
      sessionEntries: ctx.sessionManager.getBranch(),
      contextUsage: ctx.getContextUsage(),
      current,
      fileEvidenceMode: exactFiles ? "exact" : "observed",
      workingTreeFiles: exactFiles ? undefined : inspectWorkingTreeFiles(ctx.cwd)
    });
    cached.set(key, { at: Date.now(), view });
    return view;
  }

  function clearSurface(ctx: ExtensionContext): void {
    if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(INSPECTOR_SURFACE_KEY, undefined);
    if (typeof ctx.ui?.setWidget === "function") ctx.ui.setWidget("piagent-inspector", undefined);
  }

  function renderSurface(ctx: ExtensionContext, force = false): void {
    const canUseStatus = typeof ctx.ui?.setStatus === "function";
    const canUseWidget = typeof ctx.ui?.setWidget === "function";
    if (ctx.hasUI === false || (!canUseStatus && !canUseWidget)) return;
    const key = sessionKey(ctx);
    if (enabled.get(key) === false) {
      clearSurface(ctx);
      return;
    }
    try {
      const view = project(ctx, force);
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
    renderSurface(ctx, event.event === "tool_result" || event.event === "tool_decision");
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
        renderSurface(ctx, true);
        ctx.ui.notify(`Piagent Inspector footer panel: ${next ? "on" : "off"}`, "info");
        return;
      }
      const view = project(ctx, true, action === "files" || action === "security");
      const content = json ? JSON.stringify({ action, inspector: view }) : formatActivityInspector(view, action);
      dependencies.emit(ctx, `piagent-inspector-${action}`, content, { action, inspector: view });
      renderSurface(ctx);
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
  }

  return {
    observe,
    refresh: (ctx: ExtensionContext) => renderSurface(ctx, true),
    project: (ctx: ExtensionContext) => project(ctx, true, true),
    dispose
  };
}
