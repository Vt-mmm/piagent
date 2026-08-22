import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stageContextDelivery } from "../context/context-delivery.ts";

type PiagentToolGroup = any;
type TechStackManifest = any;


export function registerPolicyTools(pi: ExtensionAPI, deps: Record<string, any>): void {
  const {
    PIAGENT_TOOL_NAMES, READ_ONLY_TOOL_NAMES, StringEnum, Type, activateToolGroups, activeSessionTask,
    buildContextEfficiencyReport, buildContextIndexStatus, buildContextIndexV2, buildContextPack, buildContextPreflight,
    buildTestImpact, buildUsageSnapshot, candidateFileBudget, contextBudgetConfig, contextIndexExcludePatterns,
    contextIndexV2Status, crypto, dynamicToolsEnabled, effectiveProtectedPaths, ensureContextIndexV2,
    evaluateExecPolicy,
    evaluateTaskGate, evaluateToolPolicy, execPolicyConfig, externalActionPolicyConfig, finalGateConfig,
    formatContextPreflight, formatPercent, formatUsageSnapshot, fs, loadProfileFromContext,
    permissionOverrideFromContext, permissionProfilesConfig, policy, projectContextFilePath, projectProfilePath,
    readJsonFile, readTask, registerPiagentTool, resolveMemorySettings, resolveOrchestrationPolicy,
    resolvePermissionProfile, resolveRuntimePolicy, retrievalKey, runtimeState, searchContextIndexV2,
    techStackPath, telemetry, toolRegistryConfig, verifierCommandInstructions
  } = deps;
  registerPiagentTool(pi, {
    name: "piagent_tools",
    label: "Piagent Tool Loader",
    description: "Activate an additional Piagent tool group only when the current task needs it.",
    promptSnippet: "Load diagnostic or recovery Piagent tools only when the runtime requests them.",
    promptGuidelines: [
      "Do not call this for an ordinary implementation task; runtime evidence collection needs no extra tools.",
      "When recovery is necessary, load only the smallest group that resolves the reported missing evidence."
    ],
    parameters: Type.Object({
      groups: Type.Array(StringEnum(["intake", "governance", "task", "recovery", "policy", "retrieval", "knowledge", "onboarding", "usage"] as const), { minItems: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const groups = [...new Set(params.groups)] as PiagentToolGroup[];
      if (!dynamicToolsEnabled) {
        return {
          content: [{ type: "text", text: "Dynamic Piagent tool loading is disabled by PIAGENT_DYNAMIC_TOOLS." }],
          details: { groups, disabled: true, activePiagentTools: pi.getActiveTools().filter((toolName) => PIAGENT_TOOL_NAMES.has(toolName)) }
        };
      }
      const activeTools = activateToolGroups(ctx, groups, true);
      return {
        content: [{
          type: "text",
          text: `Piagent tools activated: ${groups.join(", ")}. Active Piagent tools: ${activeTools.filter((toolName) => PIAGENT_TOOL_NAMES.has(toolName)).length}.`
        }],
        details: {
          groups,
          activePiagentTools: activeTools.filter((toolName) => PIAGENT_TOOL_NAMES.has(toolName))
        }
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context_engine",
    label: "Pi Context Engine",
    description: "Build or query the local code index, return a token-budgeted context pack, map impacted tests, or report context efficiency.",
    promptSnippet: "Use this instead of broad repository scouting when the task needs code navigation.",
    promptGuidelines: [
      "Prefer pack for an unfamiliar task, search for a named symbol/path, impact before targeted verification, and efficiency only for usage analysis.",
      "Index evidence is advisory; re-read selected files before editing.",
      "Run one bounded finder pass only when pack confidence is low."
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "rebuild", "search", "pack", "impact", "efficiency"] as const),
      query: Type.Optional(Type.String()),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      budgetTokens: Type.Optional(Type.Number({ minimum: 200, maximum: 12000 })),
      refresh: Type.Optional(Type.Boolean())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const excludePatterns = contextIndexExcludePatterns(policy, profile);
      let result: unknown;
      let text: string;
      if (params.action === "status") {
        result = await contextIndexV2Status(ctx.cwd, { excludePatterns });
        const status = result as Awaited<ReturnType<typeof contextIndexV2Status>>;
        text = [
          `indexV2: ${status.exists ? "ready" : "missing"}`,
          `path: ${status.path}`,
          `files: ${status.files ?? 0}`,
          `symbols: ${status.symbols ?? 0}`,
          `imports: ${status.imports ?? 0}`,
          `stale: ${status.stale ? "yes" : "no"}`,
          `warnings: ${status.warnings.join("; ") || "none"}`
        ].join("\n");
      } else if (params.action === "rebuild") {
        result = await buildContextIndexV2(ctx.cwd, { excludePatterns });
        const built = result as Awaited<ReturnType<typeof buildContextIndexV2>>;
        text = [
          "indexV2: rebuilt",
          `files: ${built.files}; symbols: ${built.symbols}; imports: ${built.imports}`,
          `changed: ${built.changed}; removed: ${built.removed}`,
          `skipped: ${built.skippedLarge} large, ${built.skippedBinary} binary`,
          `duration: ${built.durationMs}ms`
        ].join("\n");
      } else if (params.action === "search") {
        if (!params.query?.trim()) throw new Error("query is required for context search");
        const ensured = await ensureContextIndexV2(ctx.cwd, {
          excludePatterns,
          refresh: params.refresh,
          rebuildMissing: true
        });
        const status = ensured.status;
        result = await searchContextIndexV2(ctx.cwd, params.query, { limit: 15, excludePatterns });
        const search = result as Awaited<ReturnType<typeof searchContextIndexV2>>;
        text = [
          `confidence: ${search.confidence}`,
          `indexStale: ${status.stale ? "yes" : "no"}`,
          ...search.results.map((item) => `- ${item.path}: ${item.sources.join("+")}; ${item.symbols.slice(0, 4).map((symbol) => `${symbol.name}@${symbol.line}`).join(", ") || "no symbols"}`)
        ].join("\n");
      } else if (params.action === "pack") {
        if (!params.query?.trim()) throw new Error("query is required for a context pack");
        const injected = runtimeState.injectedContextPack(ctx, retrievalKey(ctx, params.query));
        if (injected && params.refresh !== true) {
          result = { reusedInjectedPack: true, ...injected };
          text = [
            "Context pack already injected for this task; duplicate payload skipped.",
            `confidence: ${injected.confidence}; estimatedTokensSaved: ${injected.estimatedTokens}`,
            `paths: ${injected.paths.join(", ")}`,
            "Read only the listed files or request refresh=true when the repository changed."
          ].join("\n");
          telemetry(ctx, {
            event: "context_pack_reused",
            queryHash: injected.queryHash,
            estimatedTokensSaved: injected.estimatedTokens,
            selectedPaths: injected.paths
          });
          return { content: [{ type: "text", text }], details: result };
        }
        const ensured = await ensureContextIndexV2(ctx.cwd, {
          excludePatterns,
          refresh: params.refresh,
          rebuildMissing: true
        });
        const status = ensured.status;
        const pack = await buildContextPack(ctx.cwd, params.query, {
          budgetTokens: params.budgetTokens ?? 2_400,
          includeCode: true,
          limit: 18,
          excludePatterns
        });
        telemetry(ctx, { event: "context_pack", turnId: runtimeState.currentTurn(ctx)?.turnId, source: "context-tool", queryHash: pack.queryHash, confidence: pack.confidence, candidates: pack.candidates, selected: pack.selected.length, estimatedTokens: pack.estimatedTokens, selectedPaths: pack.selected.map((item) => item.path) });
        const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId());
        const deliveryId = task?.trace?.outcome === "pending" && pack.selected.length > 0 ? crypto.randomUUID() : undefined;
        if (deliveryId) {
          const packRetrievalKey = retrievalKey(ctx, params.query);
          stageContextDelivery(ctx, {
            deliveryId,
            taskRunId: task.taskRunId,
            turnId: runtimeState.currentTurn(ctx)?.turnId,
            entries: pack.selected.map((item) => ({
              path: item.path,
              reason: "Runtime confirmed delivery of an explicit Context Engine tool pack."
            })),
            pack: {
              retrievalKey: packRetrievalKey,
              queryHash: pack.queryHash,
              confidence: pack.confidence,
              estimatedTokens: pack.estimatedTokens,
              paths: pack.selected.map((item) => item.path)
            },
            injection: {
              source: "context-tool",
              queryHash: pack.queryHash,
              confidence: pack.confidence,
              estimatedTokens: pack.estimatedTokens,
              selectedItems: pack.selected.map((item) => ({ path: item.path, estimatedTokens: item.estimatedTokens }))
            }
          }, { state: runtimeState, telemetry });
        }
        result = { ...pack, text: undefined, status, contextDelivery: deliveryId ? { schemaVersion: 1, deliveryId } : undefined };
        text = pack.text;
      } else if (params.action === "impact") {
        await ensureContextIndexV2(ctx.cwd, { excludePatterns, rebuildMissing: false });
        result = await buildTestImpact(ctx.cwd, params.files ?? [], { excludePatterns });
        const impact = result as Awaited<ReturnType<typeof buildTestImpact>>;
        text = [
          `changed: ${impact.changedFiles.join(", ") || "none"}`,
          `impacted: ${impact.impactedFiles.map((item) => `${item.path} via ${item.via}`).join(", ") || "none"}`,
          `tests: ${impact.tests.join(", ") || "none"}`
        ].join("\n");
      } else {
        result = buildContextEfficiencyReport(ctx.cwd);
        const report = result as ReturnType<typeof buildContextEfficiencyReport>;
        text = [
          `contextWasteScore: ${report.metrics.contextWasteScore}/100 (lower is better)`,
          `activeTools: ${report.metrics.averageActiveTools}`,
          `toolSchemaShare: ${formatPercent(report.metrics.toolSchemaShare)}`,
          `duplicateReads: ${report.metrics.duplicateReads}/${report.metrics.readCalls}`,
          `duplicateOutput: ${formatPercent(report.metrics.duplicateOutputRate)}`,
          `lowConfidencePacks: ${report.metrics.lowConfidencePacks}/${report.sample.contextPacks}`,
          ...report.recommendations.map((recommendation) => `- ${recommendation}`)
        ].join("\n");
      }
      telemetry(ctx, {
        event: "context_engine_action",
        action: params.action,
        queryHash: params.query ? crypto.createHash("sha256").update(params.query).digest("hex") : undefined,
        fileCount: params.files?.length ?? 0
      });
      return { content: [{ type: "text", text }], details: result };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context",
    label: "Piagent Context",
    description: "Return the current piagent project profile, required context files, verify commands, and MCP capabilities.",
    promptSnippet: "Inspect the active piagent project profile and guard policy.",
    promptGuidelines: [
      "Use piagent_context before planning or editing in projects managed by Pi Agent Platform."
    ],
    parameters: Type.Object({
      detail: Type.Optional(StringEnum(["concise", "full"] as const))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const detail = params.detail ?? "concise";
      const profile = loadProfileFromContext(ctx);
      const permissionProfile = resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx));
      const pathPolicy = effectiveProtectedPaths(policy, profile);
      const orchestrationPolicy = resolveOrchestrationPolicy(profile, policy);
      const contextIndex = buildContextIndexStatus(ctx.cwd, profile);
      let contextEngine: Awaited<ReturnType<typeof contextIndexV2Status>> | { exists: false; warnings: string[] };
      try {
        contextEngine = await contextIndexV2Status(ctx.cwd, {
          excludePatterns: contextIndexExcludePatterns(policy, profile)
        });
      } catch (error) {
        contextEngine = { exists: false, warnings: [error instanceof Error ? error.message : String(error)] };
      }
      const requiredContext = [
        ...policy.defaultRequiredContext,
        ...(profile.requiredContext ?? [])
      ];
      const payload = {
        projectId: profile.projectId,
        displayName: profile.displayName,
        mode: profile.mode,
        projectTrusted: ctx.isProjectTrusted(),
        profile: {
          path: ".pi/piagent-profile.json",
          exists: fs.existsSync(projectProfilePath(ctx.cwd)),
          source: process.env.PIAGENT_PROFILE?.trim()
            ? "env"
            : ctx.isProjectTrusted() && fs.existsSync(projectProfilePath(ctx.cwd))
              ? "project"
              : "fallback"
        },
        projectContext: {
          path: ".pi/project-context.md",
          exists: fs.existsSync(projectContextFilePath(ctx.cwd))
        },
        contextIndex,
        contextEngine,
        protectedPaths: profile.protectedPaths ?? [],
        shellProtectedPaths: profile.shellProtectedPaths ?? profile.protectedPaths ?? [],
        readOnlyPaths: profile.readOnlyPaths ?? [],
        effectivePaths: pathPolicy,
        requiredContext: Array.from(new Set(requiredContext)),
        verifyCommands: profile.verifyCommands ?? {},
        mcpCapabilities: profile.mcpCapabilities ?? [],
        permissionProfile,
        memory: resolveMemorySettings(profile),
        techStack: {
          ...(profile.techStack ?? {}),
          manifestExists: fs.existsSync(techStackPath(ctx.cwd)),
          selected: (readJsonFile(techStackPath(ctx.cwd)) as TechStackManifest | undefined)?.selected ?? []
        },
        orchestrationPolicy,
        runtimePolicy: resolveRuntimePolicy(profile),
        policy: {
          permissionProfiles: permissionProfilesConfig(policy),
          execPolicy: execPolicyConfig(policy),
          contextBudget: contextBudgetConfig(policy),
          toolRegistry: toolRegistryConfig(policy),
          externalActionPolicy: externalActionPolicyConfig(policy),
          finalGate: finalGateConfig(policy),
          orchestrationPolicy
        }
      };

      const text = detail === "full"
        ? JSON.stringify(payload, null, 2)
        : [
        `project: ${payload.displayName ?? payload.projectId ?? "unknown"}`,
        `mode: ${payload.mode ?? "unknown"}`,
        `profile: ${payload.profile.path} (${payload.profile.exists ? "exists" : "missing"})`,
        `projectContext: ${payload.projectContext.path} (${payload.projectContext.exists ? "exists" : "missing"})`,
        `contextIndex: ${payload.contextIndex.path} (${payload.contextIndex.exists ? `${payload.contextIndex.nodes} nodes` : "missing"})`,
        `contextEngine: ${payload.contextEngine.exists ? `${payload.contextEngine.files ?? 0} files / ${payload.contextEngine.symbols ?? 0} symbols${payload.contextEngine.stale ? " / stale" : ""}` : "missing"}`,
        `requiredContext: ${payload.requiredContext.join(", ") || "none"}`,
        `verifyCommands: ${Object.keys(payload.verifyCommands).join(", ") || "none"}`,
        `mcpCapabilities: ${payload.mcpCapabilities.join(", ") || "none"}`,
        `permissionProfile: ${payload.permissionProfile.mode} (${payload.permissionProfile.runtimeEquivalent})`,
        `memory: ${payload.memory.enabled ? payload.memory.mode : "off"} (${payload.memory.summaryFile})`,
        `techStack: ${payload.techStack.selected.length ? payload.techStack.selected.map((item) => `${item.role}:${item.id}`).join(", ") : "not configured"}`,
        `orchestration: ${payload.orchestrationPolicy.defaultMode}, lenses=${payload.orchestrationPolicy.defaultReviewLenses.join("/")}, fieldGuide=${payload.orchestrationPolicy.fieldGuide.enabled ? payload.orchestrationPolicy.fieldGuide.path : "off"}`,
        `runtimePolicy: exec=${payload.runtimePolicy.execPolicy}, context=${payload.runtimePolicy.contextBudget}, tools=${payload.runtimePolicy.toolRegistry}, final=${payload.runtimePolicy.finalGate}`
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: payload
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_permission_status",
    label: "Piagent Permission Status",
    description: "Return the active runtime permission profile and the Piagent guard boundaries that still apply.",
    promptSnippet: "Use this when deciding whether the current session is read-only, workspace-write, or trusted-full-access.",
    parameters: Type.Object({
      detail: Type.Optional(StringEnum(["concise", "full"] as const))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const permissionProfile = resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx));
      const config = permissionProfilesConfig(policy);
      const payload = {
        permissionProfile,
        allowedModes: config.allowedModes,
        profileValue: profile.permissionProfile,
        envOverrideActive: Boolean(process.env.PIAGENT_PERMISSION_PROFILE?.trim()),
        commandOverrideActive: Boolean(permissionOverrideFromContext(ctx)),
        boundaries: {
          protectedPaths: "enforced",
          shellProtectedPaths: "enforced",
          secretRedaction: "enforced",
          capabilityLock: "enforced when profile declares capabilityPacks",
          destructiveExternalConfirmation: "enforced"
        },
        readOnlyAllowedTools: [...READ_ONLY_TOOL_NAMES].sort()
      };
      const text = params.detail === "full"
        ? JSON.stringify(payload, null, 2)
        : [
            `permissionProfile: ${permissionProfile.mode}`,
            `source: ${permissionProfile.source}${permissionProfile.requested ? ` (${permissionProfile.requested})` : ""}`,
            `runtimeEquivalent: ${permissionProfile.runtimeEquivalent}`,
            `allowedModes: ${config.allowedModes.join(", ")}`,
            `warning: ${permissionProfile.warning ?? "none"}`,
            "boundaries: protected-paths, secret redaction, capability lock, and destructive/external confirmations remain enforced"
          ].join("\n");
      return { content: [{ type: "text", text }], details: payload };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_exec_policy_check",
    label: "Piagent Exec Policy Check",
    description: "Evaluate a shell command against piagent exec policy before running it.",
    promptSnippet: "Use this before high-impact, complex, generated, or unfamiliar shell commands.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const result = evaluateExecPolicy(params.command, profile, policy);
      const text = [
        `decision: ${result.decision}`,
        `mode: ${result.mode}`,
        `reasons: ${result.reasons.join("; ") || "none"}`,
        "",
        "segments:",
        ...result.segments.map((segment) => `- ${segment.command}\n  words: ${segment.words.join(" ")}\n  matches: ${segment.matches.join(", ") || "none"}\n  warnings: ${segment.warnings.join(", ") || "none"}`)
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context_budget",
    label: "Piagent Context Budget",
    description: "Check candidate context files against hard context budget limits.",
    promptSnippet: "Use this before injecting or relying on large files as context.",
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const budget = contextBudgetConfig(policy);
      const results = params.files.map((file) => candidateFileBudget(ctx.cwd, file, budget));
      const overLimit = results.filter((item) => item.overLimit);
      const warnings = results.filter((item) => item.warn && !item.overLimit);
      const text = [
        `decision: ${overLimit.length ? "fail" : "pass"}`,
        `limits: maxContextFileChars=${budget.maxContextFileChars}, warnFragmentChars=${budget.warnFragmentChars}`,
        `overLimit: ${overLimit.map((item) => item.path).join(", ") || "none"}`,
        `warnings: ${warnings.map((item) => `${item.path} (${item.chars} chars)`).join(", ") || "none"}`,
        "",
        ...results.map((item) => `- ${item.path}: ${item.exists ? `${item.chars} chars` : "missing"}${item.overLimit ? " OVER_LIMIT" : item.warn ? " WARN" : ""}`)
      ].join("\n");
      return { content: [{ type: "text", text }], details: { budget, results } };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_tool_policy_check",
    label: "Piagent Tool Policy Check",
    description: "Evaluate whether a tool is registered and allowed by the active project profile capabilities.",
    promptSnippet: "Use this before relying on MCP/app/tools that are not obviously in the profile.",
    parameters: Type.Object({
      toolName: Type.String({ minLength: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const result = evaluateToolPolicy(params.toolName, profile, policy);
      const text = [
        `decision: ${result.decision}`,
        `mode: ${result.mode}`,
        `tool: ${params.toolName}`,
        `requiredCapabilities: ${result.requiredCapabilities.join(", ") || "none"}`,
        `availableCapabilities: ${result.availableCapabilities.join(", ") || "none"}`,
        `reason: ${result.reason}`
      ].join("\n");
      return { content: [{ type: "text", text }], details: result };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_task_gate_check",
    label: "Piagent Task Gate Check",
    description: "Check whether a governed task has enough context, verify evidence, and trace before claiming done.",
    promptSnippet: "Use this before final on source-changing tasks.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      changedFiles: Type.Optional(Type.Array(Type.String()))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = readTask(ctx.cwd, params.taskId, ctx.sessionManager.getSessionId());
      const projected = task ? {
        ...task,
        changedFiles: params.changedFiles ?? task.changedFiles,
        trace: { ...task.trace, outcome: "completed" as const }
      } : undefined;
      const result = evaluateTaskGate(ctx.cwd, projected, policy);
      const runtime = resolveRuntimePolicy(loadProfileFromContext(ctx));
      const text = [
        `decision: ${result.decision}`,
        `mode: ${runtime.finalGate}`,
        `missing: ${result.missing.join(", ") || "none"}`,
        ...verifierCommandInstructions(result.missingVerifyCommands),
        `warnings: ${result.warnings.join("; ") || "none"}`
      ].join("\n");
      return { content: [{ type: "text", text }], details: { ...result, task: projected } };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_usage_snapshot",
    label: "Piagent Usage Snapshot",
    description: "Return live Pi context usage, session file, model, and instructions for exact token/cost totals.",
    promptSnippet: "Use this when the user asks about token/context usage or wants to follow the current session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
      return {
        content: [{ type: "text", text: formatUsageSnapshot(snapshot) }],
        details: snapshot
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context_preflight",
    label: "Piagent Context Preflight",
    description: "Check whether the current session should run a task directly, compact first, or start a fresh governed session.",
    promptSnippet: "Use this before large, high-risk, or cross-module tasks to avoid context overflow.",
    promptGuidelines: [
      "Call this before large payment/auth/data/deploy tasks, BE-to-FE mapping, or any task where the user pasted a long intake.",
      "If recommendation is fresh-session, do not continue loading context in the current session; ask for or use a fresh workflow command.",
      "Do not paste mandatory-flow boilerplate into the task request; use platform workflow commands instead."
    ],
    parameters: Type.Object({
      workflow: Type.Optional(StringEnum(["task", "scout", "be-to-fe", "review", "plan", "platform-improve"] as const)),
      inputChars: Type.Optional(Type.Number({ minimum: 0 }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workflow = params.workflow ?? "task";
      const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
      const preflight = buildContextPreflight(snapshot, workflow, params.inputChars ?? 0);
      return {
        content: [{ type: "text", text: formatContextPreflight(preflight, snapshot) }],
        details: preflight
      };
    }
  });

}
