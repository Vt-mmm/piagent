import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionContext = any;
type TaskContract = any;

export function registerSessionCommands(pi: ExtensionAPI, deps: Record<string, any>): any {
  const {
    TOOL_RESULT_CAPTURE_MAX_CHARS, TOOL_RESULT_COMPACT_CHAR_THRESHOLD, TOOL_RESULT_COMPACT_LINE_THRESHOLD, TOOL_RESULT_PREVIEW_MAX_CHARS, activeSessionTask,
    appendSessionTrace, buildUsageSnapshot, classifyContextTask, cleanSessionNameInput, commandArgs,
    currentSessionName, effectiveProtectedPaths, emitContextEfficiency, emitContextPreflight, emitRuntimeMessage,
    evaluateRuntimeSolver, evaluateModelRoute, evaluateRetrievalRoute, formatCount, formatPercent, formatToolResultCaptureStatus, formatUsageSnapshot, helpersMode,
    loadProfileFromContext, matchesProtectedPath, policy, readRecentToolResultCaptures, redactText, resolveRuntimePolicy,
    registerTaskPreflightCommand, runtimeSnapshotCapture, runtimeSnapshotEnabled, runtimeVersions, selectRuntimeAction,
    shellArg, solverShadow, startFreshWorkflow, trajectoryRuntime, usageExactCommands
  } = deps;
  function emitUsageSnapshot(ctx: ExtensionContext): void {
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    const context = snapshot.contextUsage
      ? `${formatCount(snapshot.contextUsage.tokens)} / ${formatCount(snapshot.contextUsage.contextWindow)} (${formatPercent(snapshot.contextUsage.percent)})`
      : "context unavailable";
    ctx.ui.notify(`Piagent usage: ${context}`, "info");
    emitRuntimeMessage(ctx, "piagent-usage-snapshot", formatUsageSnapshot(snapshot), snapshot);
  }

  function emitUsageHistoryHint(ctx: ExtensionContext): void {
    const commands = usageExactCommands(ctx.cwd);
    emitRuntimeMessage(ctx, "piagent-usage-history-help", [
      "usageHistory: terminal/RPC report",
      `project: ${redactText(ctx.cwd)}`,
      `current: ${commands[1]}`,
      `history: ${commands[2]}`,
      `weeklyCsv: ${commands[3]}`,
      "insidePi: /session",
      "note: history reads ~/.pi/agent/sessions/**/*.jsonl, including ended sessions and subagents unless --no-subagents is used"
    ].join("\n"), { commands });
  }

  function emitToolLogCaptures(ctx: ExtensionContext): void {
    const captures = readRecentToolResultCaptures(ctx.cwd, 5);
    ctx.ui.notify(`Piagent logs: ${captures.length ? `${captures.length} recent capture(s)` : "no compacted captures yet"}`, "info");
    emitRuntimeMessage(ctx, "piagent-log-captures", formatToolResultCaptureStatus(ctx.cwd, captures), {
      policy: {
        compactAboveChars: TOOL_RESULT_COMPACT_CHAR_THRESHOLD,
        compactAboveLines: TOOL_RESULT_COMPACT_LINE_THRESHOLD,
        previewMaxChars: TOOL_RESULT_PREVIEW_MAX_CHARS,
        captureMaxChars: TOOL_RESULT_CAPTURE_MAX_CHARS
      },
      captures
    });
  }

  async function runUsageNamespace(raw: string, ctx: ExtensionContext): Promise<void> {
    const { action, rest } = commandArgs(raw);
    if (!action) {
      const chosen = await selectRuntimeAction(ctx, "Piagent usage", [
        { value: "live", label: "Live usage", description: "Current context/session/model", recommended: true },
        { value: "history", label: "History/report", description: "Exact terminal commands for old sessions and weekly CSV" },
        { value: "preflight", label: "Preflight", description: "Check task/context health" },
        { value: "compact", label: "Compact", description: "Compact current session with Piagent carry-over rules" },
        { value: "logs", label: "Tool logs", description: "Recent compacted large tool outputs" },
        { value: "efficiency", label: "Efficiency", description: "Context waste score and causes" },
        { value: "help", label: "Help", description: "Show typed forms" }
      ], "live");
      if (chosen === "live") {
        emitUsageSnapshot(ctx);
        return;
      }
      if (chosen === "history") {
        emitUsageHistoryHint(ctx);
        return;
      }
      if (chosen === "preflight") {
        emitContextPreflight(ctx, "task");
        return;
      }
      if (chosen === "compact") {
        emitContextPreflight(ctx, "task compact", true);
        return;
      }
      if (chosen === "logs") {
        emitToolLogCaptures(ctx);
        return;
      }
      if (chosen === "efficiency") {
        emitContextEfficiency(ctx);
        return;
      }
      emitRuntimeMessage(ctx, "piagent-usage-help", [
        "namespace: /usage",
        "live: /usage live",
        "history: /usage history",
        "preflight: /usage preflight [task|scout|be-to-fe]",
        "compact: /usage compact [task|scout|be-to-fe]",
        "logs: /usage logs",
        "efficiency: /usage efficiency",
        "native exact session: /session",
        "legacy: /piagent-usage | /task-preflight | /logs"
      ].join("\n"));
      return;
    }
    if (["live", "status", "current", "context"].includes(action)) {
      emitUsageSnapshot(ctx);
      return;
    }
    if (["history", "cost", "exact", "report", "reports"].includes(action)) {
      emitUsageHistoryHint(ctx);
      return;
    }
    if (["preflight", "check"].includes(action)) {
      emitContextPreflight(ctx, rest || "task");
      return;
    }
    if (action === "compact") {
      emitContextPreflight(ctx, `${rest || "task"} compact`, true);
      return;
    }
    if (["logs", "log"].includes(action)) {
      emitToolLogCaptures(ctx);
      return;
    }
    if (["efficiency", "stats", "waste"].includes(action)) {
      emitContextEfficiency(ctx);
      return;
    }
    if (action === "help") {
      emitRuntimeMessage(ctx, "piagent-usage-help", [
        "namespace: /usage",
        "live | history | preflight | compact | logs | efficiency",
        "examples:",
        "/usage live",
        "/usage history",
        "/usage compact scout"
      ].join("\n"));
      return;
    }
    emitRuntimeMessage(ctx, "piagent-usage-error", `unknown usage action: ${action}\nRun /usage help`, { action }, { message: `Unknown usage action: ${action}`, level: "warning" });
  }

  function setSessionNameFromCommand(ctx: ExtensionContext, raw: string, usage = "/name <task/session name>"): void {
    const name = cleanSessionNameInput(raw);
    if (!name) {
      ctx.ui.notify(`Usage: ${usage}`, "warning");
      return;
    }
    const previousName = currentSessionName(ctx);
    pi.setSessionName(name);
    appendSessionTrace(pi, {
      event: "session_name_set",
      previousName: previousName || undefined,
      sessionName: name
    });
    ctx.ui.notify(`Session name set: ${name}`, "info");
    emitRuntimeMessage(ctx, "piagent-session-name-set", `sessionName: ${name}`, { sessionName: name, previousName: previousName || undefined });
  }

  function emitSessionStatus(ctx: ExtensionContext): void {
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    emitRuntimeMessage(ctx, "piagent-session-status", [
      `session: ${snapshot.sessionName ?? "unnamed"} (${snapshot.sessionId ?? "unknown"})`,
      `file: ${snapshot.sessionFile ?? "not persisted"}`,
      `cwd: ${redactText(snapshot.cwd)}`,
      `model: ${snapshot.model}; thinking: ${snapshot.thinkingLevel}`,
      `entries: ${formatCount(snapshot.entries.branch)} active / ${formatCount(snapshot.entries.total)} total`,
      "name: Pi native /name <task name>",
      "resume: use Pi native /resume or /session"
    ].join("\n"), snapshot, { message: `Piagent session: ${snapshot.sessionName ?? "unnamed"}`, level: "info" });
  }

  function emitSessionResumeHelp(ctx: ExtensionContext): void {
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    const sessionFile = snapshot.sessionFile ? shellArg(snapshot.sessionFile) : "<session-file>";
    emitRuntimeMessage(ctx, "piagent-session-resume-help", [
      `session: ${snapshot.sessionName ?? "unnamed"} (${snapshot.sessionId ?? "unknown"})`,
      `file: ${snapshot.sessionFile ?? "not persisted"}`,
      "continueLatest: pi --continue",
      "pickByName: pi --resume",
      `exactFile: pi --session ${sessionFile}`,
      "afterResume: run Pi native /session and /usage live"
    ].join("\n"), snapshot);
  }

  async function runSessionNamespace(raw: string, ctx: any): Promise<void> {
    const { action, rest } = commandArgs(raw);
    if (!action) {
      const chosen = await selectRuntimeAction(ctx, "Piagent session", [
        { value: "current", label: "Current session", description: "Name, id, file, model", recommended: true },
        { value: "name", label: "Set name", description: "Use Pi native /name <task name>" },
        { value: "resume", label: "Resume help", description: "Commands for continuing old sessions" },
        { value: "fresh-task", label: "Fresh task", description: "Use /fresh task <request>" },
        { value: "fresh-scout", label: "Fresh scout", description: "Use /fresh scout <request>" },
        { value: "usage", label: "Usage", description: "Current context/session usage" },
        { value: "help", label: "Help", description: "Show typed forms" }
      ], "current");
      if (chosen === "current") {
        emitSessionStatus(ctx);
        return;
      }
      if (chosen === "resume") {
        emitSessionResumeHelp(ctx);
        return;
      }
      if (chosen === "usage") {
        emitUsageSnapshot(ctx);
        return;
      }
      emitRuntimeMessage(ctx, "piagent-session-help", [
        "session helpers:",
        "current: /usage live or Pi native /session",
        "name: Pi native /name <task/session name>",
        "fresh: /fresh task|scout|be-to-fe <request>",
        "resume: Pi native /resume or /session",
        "legacy: /piagent-session | /setname | /fresh-task | /fresh-scout | /fresh-be-to-fe"
      ].join("\n"));
      return;
    }
    if (["current", "status", "show"].includes(action)) {
      emitSessionStatus(ctx);
      return;
    }
    if (["name", "set", "rename"].includes(action)) {
      setSessionNameFromCommand(ctx, rest);
      return;
    }
    if (action === "resume") {
      emitSessionResumeHelp(ctx);
      return;
    }
    if (["usage", "cost"].includes(action)) {
      emitUsageSnapshot(ctx);
      return;
    }
    if (["fresh", "new"].includes(action)) {
      const next = commandArgs(rest);
      const workflow = next.action === "be-to-fe" ? "be-to-fe" : next.action === "scout" ? "scout" : "task";
      await startFreshWorkflow(workflow, next.rest, ctx);
      return;
    }
    if (["fresh-task", "task"].includes(action)) {
      await startFreshWorkflow("task", rest, ctx);
      return;
    }
    if (["fresh-scout", "scout"].includes(action)) {
      await startFreshWorkflow("scout", rest, ctx);
      return;
    }
    if (["fresh-be-to-fe", "be-to-fe"].includes(action)) {
      await startFreshWorkflow("be-to-fe", rest, ctx);
      return;
    }
    if (action === "help") {
      emitRuntimeMessage(ctx, "piagent-session-help", [
        "session helpers:",
        "/usage live",
        "Pi native: /name ABC-123 Short task name",
        "/fresh task Implement <request>",
        "native: /session | /resume"
      ].join("\n"));
      return;
    }
    setSessionNameFromCommand(ctx, [action, rest].filter(Boolean).join(" "));
  }

  pi.registerCommand("piagent-usage", {
    description: "Legacy alias for /usage",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["live", "history", "preflight", "compact", "logs", "efficiency", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runUsageNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("usage", {
    description: "Usage namespace: live, history, preflight, compact, and logs without a model follow-up",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["live", "history", "preflight", "compact", "logs", "efficiency", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runUsageNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("piagent-logs", {
    description: "Legacy alias for /usage logs",
    handler: async (_args, ctx) => {
      emitToolLogCaptures(ctx);
    }
  });

  pi.registerCommand("logs", {
    description: "Show recent compacted large tool outputs without a model follow-up",
    handler: async (_args, ctx) => {
      emitToolLogCaptures(ctx);
    }
  });

  pi.registerCommand("piagent-session", {
    description: "Legacy session helper namespace; prefer /usage, Pi native /name, and /fresh",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["current", "name", "resume", "fresh", "usage", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runSessionNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("setname", {
    description: "Compatibility alias for Pi native /name",
    handler: async (args, ctx) => {
      setSessionNameFromCommand(ctx, String(args ?? ""), "/setname <task/session name>");
    }
  });

  registerTaskPreflightCommand(pi, {
    emitContext: emitContextPreflight,
    evaluate: (ctx, request) => {
      const snapshot = runtimeSnapshotEnabled ? runtimeSnapshotCapture.capture(ctx, { effectiveThinkingLevel: String(pi.getThinkingLevel()), versions: runtimeVersions }) : undefined;
      const signal = classifyContextTask(request), protectedPaths = effectiveProtectedPaths(policy, loadProfileFromContext(ctx)).readProtectedPaths;
      return evaluateRuntimeSolver(solverShadow, { request, ctx, profile: loadProfileFromContext(ctx), activeTask: activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined, runtimeSnapshot: snapshot, effort: String(pi.getThinkingLevel()), protectedTarget: signal.paths.length > 0 && signal.paths.every((item) => matchesProtectedPath(item, protectedPaths)) });
    },
    emit: emitRuntimeMessage,
    trajectoryStatus: (ctx) => trajectoryRuntime.status(ctx.cwd, (activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined)?.taskRunId),
    productInput: async (ctx, evaluation) => {
      const profile = loadProfileFromContext(ctx);
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      const snapshot = runtimeSnapshotEnabled ? runtimeSnapshotCapture.capture(ctx, { effectiveThinkingLevel: String(pi.getThinkingLevel()), versions: runtimeVersions }) : undefined;
      const feature = evaluation.status === "ok" ? evaluation.features : undefined;
      const approvals = feature ? [feature.externalAction ? "external-action" : "", feature.destructiveAction ? "destructive-action" : "", feature.permissionExpansion ? "permission-expansion" : ""].filter(Boolean) : [];
      const modelRoute = feature ? await evaluateModelRoute?.(ctx, feature, snapshot) : undefined;
      const retrievalRoute = feature ? await evaluateRetrievalRoute?.(ctx, feature) : undefined;
      return { runtime: snapshot, modelRoute: modelRoute?.status === "ok" ? modelRoute.decision : null, retrievalRoute: retrievalRoute ?? null, scope: task?.scope ?? [], protectedPaths: effectiveProtectedPaths(policy, profile).readProtectedPaths, activeToolGroups: pi.getActiveTools(), helperMode: helpersMode(), helperBudget: "2-concurrent/3-total", executionBackend: "host", executionBoundary: "host execution is not a sandbox", approvals, blockers: feature?.protectedTarget ? ["protected-target"] : [], controlMode: evaluation.status === "ok" && evaluation.decision.mode === "shadow" ? "shadow" : resolveRuntimePolicy(profile).finalGate === "enforce" ? "enforce" : "assist" };
    }
  });

}
