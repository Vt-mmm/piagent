import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stageContextDelivery } from "../context/context-delivery.ts";

type ExtensionContext = any;

export function registerContextCommands(pi: ExtensionAPI, deps: Record<string, any>): any {
  const {
    activeSessionTask, buildContextEfficiencyReport, buildContextIndexStatus, buildContextIndexV2, buildContextPack, buildContextPreflight,
    buildTaskEfficiencyMetrics,
    buildTestImpact, buildUsageSnapshot, commandArgs, compactSessionTask, contextIndexExcludePatterns,
    contextIndexV2Status, crypto, emitRuntimeMessage, ensureContextIndexV2, estimateContextTokens,
    formatContextPreflight,
    formatCount, formatPercent, fs, helpersMode, loadProfileFromContext, memoryHandbookPath,
    policy, projectFilePath, resolveMemorySettings, resolveOrchestrationPolicy, retrievalKey, runtimeState, searchContextIndex,
    searchContextIndexV2, selectRuntimeAction, semanticCompactionInstructions, telemetry
  } = deps;
  function emitContextIndexSearch(ctx: ExtensionContext, query: string): void {
    const profile = loadProfileFromContext(ctx);
    let matches: Array<{ id: string; kind: string; label: string; match: string }> = [];
    let error: string | undefined;
    try {
      matches = query ? searchContextIndex(ctx.cwd, profile, query, 8) : [];
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    emitRuntimeMessage(ctx, "piagent-context-index-search", error
      ? `Context index search failed: ${error}`
      : matches.length
      ? matches.map((match) => `${match.id} [${match.kind}] ${match.label}: ${match.match}`).join("\n")
      : "No context index matches.", { query, matches, error });
  }

  function emitContextIndexStatus(ctx: ExtensionContext): void {
    const profile = loadProfileFromContext(ctx);
    const status = buildContextIndexStatus(ctx.cwd, profile);
    ctx.ui.notify(`Context index: ${status.exists ? `${status.nodes} nodes` : "missing"}`, status.warnings.length ? "warning" : "info");
    emitRuntimeMessage(ctx, "piagent-context-index-status", [
      `contextIndex: ${status.enabled ? "enabled" : "off"}`,
      `path: ${status.path} (${status.exists ? "exists" : "missing"})`,
      `nodes: ${status.nodes}`,
      `edges: ${status.edges}`,
      `citations: ${status.citations}`,
      `updatedAt: ${status.updatedAt ?? "never"}`,
      `warnings: ${status.warnings.join("; ") || "none"}`
    ].join("\n"), status);
  }

  async function emitContextEngineStatus(ctx: ExtensionContext): Promise<void> {
    try {
      const status = await contextIndexV2Status(ctx.cwd, {
        excludePatterns: contextIndexExcludePatterns(policy, loadProfileFromContext(ctx))
      });
      emitRuntimeMessage(ctx, "piagent-context-engine-status", [
        `contextEngine: ${status.exists ? "ready" : "missing"}`,
        `path: ${status.path}`,
        `files: ${status.files ?? 0}`,
        `symbols: ${status.symbols ?? 0}`,
        `imports: ${status.imports ?? 0}`,
        `builtAt: ${status.builtAt ?? "never"}`,
        `stale: ${status.stale ? "yes" : "no"}`,
        `warnings: ${status.warnings.join("; ") || "none"}`,
        "rebuild: /context rebuild"
      ].join("\n"), status);
    } catch (error) {
      emitRuntimeMessage(ctx, "piagent-context-engine-status", `Context Engine status failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function rebuildContextEngine(ctx: ExtensionContext): Promise<void> {
    const profile = loadProfileFromContext(ctx);
    const excludePatterns = contextIndexExcludePatterns(policy, profile);
    try {
      const result = await buildContextIndexV2(ctx.cwd, {
        excludePatterns
      });
      telemetry(ctx, { event: "context_engine_action", action: "rebuild", ...result });
      emitRuntimeMessage(ctx, "piagent-context-engine-rebuild", [
        "contextEngine: rebuilt",
        `files: ${result.files}; symbols: ${result.symbols}; imports: ${result.imports}`,
        `changed: ${result.changed}; removed: ${result.removed}`,
        `skipped: ${result.skippedLarge} large, ${result.skippedBinary} binary`,
        `duration: ${result.durationMs}ms`
      ].join("\n"), result);
    } catch (error) {
      emitRuntimeMessage(ctx, "piagent-context-engine-rebuild", `Context Engine rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function emitContextEngineSearch(ctx: ExtensionContext, query: string): Promise<boolean> {
    const excludePatterns = contextIndexExcludePatterns(policy, loadProfileFromContext(ctx));
    const { status } = await ensureContextIndexV2(ctx.cwd, {
      excludePatterns,
      rebuildMissing: false
    });
    if (!status.exists || !query.trim()) return false;
    const search = await searchContextIndexV2(ctx.cwd, query, { limit: 12, excludePatterns });
    emitRuntimeMessage(ctx, "piagent-context-engine-search", [
      `confidence: ${search.confidence}`,
      `stale: ${status.stale ? "yes" : "no"}`,
      ...search.results.map((item) => `- ${item.path}: ${item.sources.join("+")}; ${item.symbols.slice(0, 4).map((symbol) => `${symbol.name}@${symbol.line}`).join(", ") || "no symbols"}`)
    ].join("\n"), { queryHash: crypto.createHash("sha256").update(query).digest("hex"), search });
    return true;
  }

  async function emitContextPack(ctx: ExtensionContext, query: string): Promise<void> {
    if (!query.trim()) {
      emitRuntimeMessage(ctx, "piagent-context-pack-help", "Usage: /context pack <task or symbol>");
      return;
    }
    const excludePatterns = contextIndexExcludePatterns(policy, loadProfileFromContext(ctx));
    const { status } = await ensureContextIndexV2(ctx.cwd, {
      excludePatterns,
      rebuildMissing: false
    });
    if (!status.exists) {
      emitRuntimeMessage(ctx, "piagent-context-pack-help", "Context Engine index is missing. Run /context rebuild first.");
      return;
    }
    const pack = await buildContextPack(ctx.cwd, query, {
      budgetTokens: 1_500,
      includeCode: false,
      limit: 15,
      excludePatterns
    });
    telemetry(ctx, {
      event: "context_pack",
      turnId: runtimeState.currentTurn(ctx)?.turnId,
      queryHash: pack.queryHash,
      confidence: pack.confidence,
      candidates: pack.candidates,
      selected: pack.selected.length,
      estimatedTokens: pack.estimatedTokens,
      selectedPaths: pack.selected.map((item) => item.path),
      source: "command"
    });
    const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId());
    const deliveryId = task?.trace?.outcome === "pending" && pack.selected.length > 0 ? crypto.randomUUID() : undefined;
    if (deliveryId) {
      stageContextDelivery(ctx, {
        deliveryId,
        taskRunId: task.taskRunId,
        turnId: runtimeState.currentTurn(ctx)?.turnId,
        entries: pack.selected.map((item) => ({
          path: item.path,
          reason: "Runtime confirmed delivery of a /context pack message."
        })),
        pack: {
          retrievalKey: retrievalKey(ctx, query),
          queryHash: pack.queryHash,
          confidence: pack.confidence,
          estimatedTokens: pack.estimatedTokens,
          paths: pack.selected.map((item) => item.path)
        },
        injection: {
          source: "context-command",
          queryHash: pack.queryHash,
          confidence: pack.confidence,
          estimatedTokens: pack.estimatedTokens,
          selectedItems: pack.selected.map((item) => ({ path: item.path, estimatedTokens: item.estimatedTokens }))
        }
      }, { state: runtimeState, telemetry });
    }
    emitRuntimeMessage(ctx, "piagent-context-pack-v2", pack.text, {
      queryHash: pack.queryHash,
      confidence: pack.confidence,
      estimatedTokens: pack.estimatedTokens,
      paths: pack.selected.map((item) => item.path),
      finderRecommended: pack.finderRecommended,
      contextDelivery: deliveryId ? { schemaVersion: 1, deliveryId } : undefined
    });
  }

  async function emitTestImpact(ctx: ExtensionContext, raw: string): Promise<void> {
    const files = raw.split(/\s+/).map((file) => file.trim()).filter(Boolean);
    const excludePatterns = contextIndexExcludePatterns(policy, loadProfileFromContext(ctx));
    await ensureContextIndexV2(ctx.cwd, { excludePatterns, rebuildMissing: false });
    const impact = await buildTestImpact(ctx.cwd, files, { excludePatterns });
    emitRuntimeMessage(ctx, "piagent-context-impact", [
      `changed: ${impact.changedFiles.join(", ") || "none"}`,
      `impacted: ${impact.impactedFiles.map((item) => `${item.path} via ${item.via}`).join(", ") || "none"}`,
      `tests: ${impact.tests.join(", ") || "none"}`
    ].join("\n"), impact);
  }

  function emitContextEfficiency(ctx: ExtensionContext): void {
    const report = buildContextEfficiencyReport(ctx.cwd);
    const task = activeSessionTask(ctx);
    const taskEfficiency = task ? buildTaskEfficiencyMetrics(ctx.cwd, task) : null;
    emitRuntimeMessage(ctx, "piagent-context-efficiency", [
      `contextWasteScore: ${report.metrics.contextWasteScore}/100 (lower is better)`,
      `activeTools: ${report.metrics.averageActiveTools}`,
      `toolSchemaShare: ${formatPercent(report.metrics.toolSchemaShare)}`,
      `duplicateReads: ${report.metrics.duplicateReads}/${report.metrics.readCalls}`,
      `duplicateOutput: ${formatPercent(report.metrics.duplicateOutputRate)}`,
      `lowConfidencePacks: ${report.metrics.lowConfidencePacks}/${report.sample.contextPacks}`,
      `taskEfficiency: ${taskEfficiency ? `${taskEfficiency.solver.route}; verify=${taskEfficiency.verification.attempts}; outcome=${taskEfficiency.outcome.task}` : "no active task"}`,
      ...report.recommendations.map((recommendation) => `- ${recommendation}`)
    ].join("\n"), { ...report, taskEfficiency });
  }

  function parsePreflightWorkflow(raw: string): string {
    return raw.match(/\b(?:scout|be-to-fe|review|plan|platform-improve|task)\b/i)?.[0]?.toLowerCase() ?? "task";
  }

  function compactCurrentSession(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const instructions = semanticCompactionInstructions(ctx.cwd, sessionId);
    telemetry(ctx, {
      event: "compaction_requested",
      mode: "semantic",
      instructionTokens: estimateContextTokens(instructions),
      hasTaskContract: Boolean(compactSessionTask(ctx.cwd, sessionId))
    });
    ctx.compact({
      customInstructions: instructions
    });
  }

  function emitContextPreflight(ctx: ExtensionContext, raw: string, shouldCompact = false): void {
    const workflow = parsePreflightWorkflow(raw);
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    const preflight = buildContextPreflight(snapshot, workflow, raw.length);
    const context = snapshot.contextUsage
      ? `${formatCount(snapshot.contextUsage.tokens)} / ${formatCount(snapshot.contextUsage.contextWindow)} (${formatPercent(snapshot.contextUsage.percent)})`
      : "context unavailable";
    ctx.ui.notify(`Task preflight: ${preflight.recommendation}; ${context}`, preflight.recommendation === "ok" ? "info" : "warning");
    if (shouldCompact) compactCurrentSession(ctx);
    emitRuntimeMessage(ctx, "piagent-task-preflight", formatContextPreflight(preflight, snapshot), preflight);
  }

  async function runPiagentContextNamespace(raw: string, ctx: ExtensionContext): Promise<void> {
    const { action, rest } = commandArgs(raw);
    if (!action) {
      const chosen = await selectRuntimeAction(ctx, "Piagent context", [
        { value: "index", label: "Index status", description: "Architecture map plus local code index", recommended: true },
        { value: "pack", label: "Context pack", description: "Rank paths and symbols for a task" },
        { value: "impact", label: "Test impact", description: "Map changed files to dependents and tests" },
        { value: "efficiency", label: "Efficiency", description: "Show transparent context waste metrics" },
        { value: "rebuild", label: "Rebuild index", description: "Incrementally refresh changed files" },
        { value: "preflight", label: "Preflight", description: "Check whether to run, compact, or fresh-session" },
        { value: "compact", label: "Compact", description: "Compact current session with Piagent carry-over rules" },
        { value: "search", label: "Search index", description: "Use /context search <keyword>" },
        { value: "help", label: "Help", description: "Show typed forms" }
      ], "index");
      if (chosen === "index") {
        emitContextIndexStatus(ctx);
        await emitContextEngineStatus(ctx);
        return;
      }
      if (chosen === "rebuild") {
        await rebuildContextEngine(ctx);
        return;
      }
      if (chosen === "efficiency") {
        emitContextEfficiency(ctx);
        return;
      }
      if (chosen === "pack") {
        await emitContextPack(ctx, "");
        return;
      }
      if (chosen === "impact") {
        await emitTestImpact(ctx, "");
        return;
      }
      if (chosen === "search") {
        emitRuntimeMessage(ctx, "piagent-context-search-help", "Usage: /context search <keyword or symbol>");
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
      emitRuntimeMessage(ctx, "piagent-context-help", [
        "namespace: /context",
        "index: /context index",
        "rebuild: /context rebuild",
        "search: /context search <keyword>",
        "pack: /context pack <task or symbol>",
        "impact: /context impact [changed files]",
        "efficiency: /context efficiency",
        "preflight: /context preflight [task|scout|be-to-fe|review|plan]",
        "compact: /context compact [task|scout|be-to-fe]",
        "legacy: /piagent-context | /context-index | /task-preflight"
      ].join("\n"));
      return;
    }
    if (["index", "status", "show", "current"].includes(action)) {
      emitContextIndexStatus(ctx);
      await emitContextEngineStatus(ctx);
      return;
    }
    if (["rebuild", "build", "refresh"].includes(action)) {
      await rebuildContextEngine(ctx);
      return;
    }
    if (action === "search") {
      try {
        if (!await emitContextEngineSearch(ctx, rest)) emitContextIndexSearch(ctx, rest);
      } catch {
        emitContextIndexSearch(ctx, rest);
      }
      return;
    }
    if (action === "pack") {
      await emitContextPack(ctx, rest);
      return;
    }
    if (["impact", "tests"].includes(action)) {
      await emitTestImpact(ctx, rest);
      return;
    }
    if (["efficiency", "stats", "waste"].includes(action)) {
      emitContextEfficiency(ctx);
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
    if (action === "help") {
      emitRuntimeMessage(ctx, "piagent-context-help", [
        "namespace: /context",
        "index: /context index",
        "rebuild: /context rebuild",
        "search: /context search <keyword>",
        "pack: /context pack <task or symbol>",
        "impact: /context impact [changed files]",
        "efficiency: /context efficiency",
        "preflight: /context preflight [task|scout|be-to-fe|review|plan]",
        "compact: /context compact [task|scout|be-to-fe]",
        "legacy: /piagent-context | /context-index | /task-preflight"
      ].join("\n"));
      return;
    }
    emitContextIndexSearch(ctx, [action, rest].filter(Boolean).join(" "));
  }

  pi.registerCommand("piagent-context", {
    description: "Legacy alias for /context",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["index", "rebuild", "search", "pack", "impact", "efficiency", "preflight", "compact", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runPiagentContextNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("context", {
    description: "Context index, retrieval pack, test impact, efficiency, preflight, and compact controls without a model follow-up",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["index", "rebuild", "search", "pack", "impact", "efficiency", "preflight", "compact", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runPiagentContextNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("context-index", {
    description: "Legacy alias for /context index/search",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      await runPiagentContextNamespace(raw ? raw : "index", ctx);
    }
  });

  pi.registerCommand("piagent-orchestration", {
    description: "Show solo-first subagent, review lens, model-role, and Field Guide policy",
    handler: async (_args, ctx) => {
      const profile = loadProfileFromContext(ctx);
      const settings = resolveMemorySettings(profile);
      const orchestration = resolveOrchestrationPolicy(profile, policy);
      let fieldGuidePath = orchestration.fieldGuide.path || settings.handbookFile;
      let fieldGuideExists = false;
      try {
        fieldGuideExists = fs.existsSync(projectFilePath(ctx.cwd, fieldGuidePath));
      } catch {
        fieldGuidePath = settings.handbookFile;
        fieldGuideExists = fs.existsSync(memoryHandbookPath(ctx.cwd, settings));
      }
      ctx.ui.notify(`Piagent orchestration: ${orchestration.defaultMode}`, "info");
      pi.sendMessage(
        {
          customType: "piagent-orchestration-policy",
          content: [
            `mode: ${orchestration.defaultMode}`,
            `helpersMode: ${helpersMode()}`,
            `subagents: bounded read-only scout/planning/review; max ${orchestration.maxConcurrentSubagents}`,
            `lenses: ${orchestration.defaultReviewLenses.join(", ")}`,
            `fieldGuide: ${orchestration.fieldGuide.enabled ? `${fieldGuidePath} (${fieldGuideExists ? "exists" : "missing"})` : "off"}`,
            "writer: single writer by default; parallel writers need explicit approval + isolation"
          ].join("\n"),
          display: true,
          details: {
            ...orchestration,
            helpersMode: helpersMode(),
            fieldGuide: {
              ...orchestration.fieldGuide,
              path: fieldGuidePath,
              exists: fieldGuideExists
            }
          }
        },
        { triggerTurn: false }
      );
    }
  });

  return { emitContextEfficiency, emitContextPreflight };
}
