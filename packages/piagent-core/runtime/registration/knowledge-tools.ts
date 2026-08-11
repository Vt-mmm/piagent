import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerKnowledgeTools(pi: ExtensionAPI, deps: Record<string, any>): void {
  const {
    CONTEXT_INDEX_EDGE_KINDS, CONTEXT_INDEX_NODE_KINDS, StringEnum, Type, appendMemoryNote,
    appendSessionTrace, appendTrace, buildContextIndexStatus, fs, loadProfileFromContext,
    defaultRolePolicy, helpersMode, memoryHandbookPath, memoryLocalDir, memorySummaryPath, policy, projectFilePath,
    registerPiagentTool, resolveMemorySettings, resolveOrchestrationPolicy, searchContextIndex, searchMemoryFiles,
    writeContextIndex
  } = deps;
  registerPiagentTool(pi, {
    name: "piagent_orchestration_policy",
    label: "Piagent Orchestration Policy",
    description: "Return solo-first subagent, review lens, model-role, and Field Guide policy for the current project.",
    promptSnippet: "Use this before planning medium/large tasks so orchestration stays single-agent-first and token-aware.",
    promptGuidelines: [
      "Default to the parent agent plus bounded subagents only when they reduce context risk or improve review quality.",
      "Use review lenses instead of spawning a broad swarm.",
      "Treat Field Guide memory as advisory and verify it against current repository files."
    ],
    parameters: Type.Object({
      detail: Type.Optional(StringEnum(["concise", "full"] as const))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      const payload = {
        ...orchestration,
        helpersMode: helpersMode(),
        rolePolicies: ["retriever", "scout", "planner", "worker", "reviewer", "oracle", "researcher"].map((role) => {
          const rolePolicy = defaultRolePolicy(role);
          return { role, authority: rolePolicy.authority, enabledByDefault: rolePolicy.enabledByDefault, allowedTools: rolePolicy.allowedTools, contextBudget: rolePolicy.contextBudget, ceilings: rolePolicy.ceilings };
        }),
        fieldGuide: {
          ...orchestration.fieldGuide,
          path: fieldGuidePath,
          exists: fieldGuideExists
        },
        stance: "single-agent-first; subagents are opt-in tools for bounded scout, planning, and review"
      };
      const text = params.detail === "full"
        ? JSON.stringify(payload, null, 2)
        : [
          `mode: ${payload.defaultMode}`,
          `maxConcurrentSubagents: ${payload.maxConcurrentSubagents}`,
          `helpersMode: ${payload.helpersMode}`,
          `reviewLenses: ${payload.defaultReviewLenses.join(", ")}`,
          `fieldGuide: ${payload.fieldGuide.enabled ? `${payload.fieldGuide.path} (${payload.fieldGuide.exists ? "exists" : "missing"})` : "off"}`,
          `fieldGuidePolicy: ${payload.fieldGuide.writePolicy}, maxLines=${payload.fieldGuide.maxLines}`,
          "modelRoles:",
          `- planner: ${payload.roleModelGuidance.planner}`,
          `- worker: ${payload.roleModelGuidance.worker}`,
          `- reviewer: ${payload.roleModelGuidance.reviewer}`,
          `- watchdog: ${payload.roleModelGuidance.watchdog}`,
          "rules:",
          ...payload.rules.map((rule) => `- ${rule}`)
        ].join("\n");
      return { content: [{ type: "text", text }], details: payload };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_memory_status",
    label: "Piagent Memory Status",
    description: "Return the project memory policy, files, and safe usage rules.",
    promptSnippet: "Inspect project memory policy before relying on remembered facts.",
    promptGuidelines: [
      "Use memory as hints, not source of truth.",
      "Verify memory against repository files before making source changes.",
      "Never store secrets or raw private data in memory."
    ],
    parameters: Type.Object({
      detail: Type.Optional(StringEnum(["concise", "full"] as const))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const settings = resolveMemorySettings(profile);
      const summaryPath = memorySummaryPath(ctx.cwd, settings);
      const handbookPath = memoryHandbookPath(ctx.cwd, settings);
      const payload = {
        enabled: settings.enabled,
        mode: settings.mode,
        scope: settings.scope,
        readBeforeTask: settings.readBeforeTask,
        writePolicy: settings.writePolicy,
        maxInjectedChars: settings.maxInjectedChars,
        files: {
          summary: { path: settings.summaryFile, exists: fs.existsSync(summaryPath) },
          handbook: { path: settings.handbookFile, exists: fs.existsSync(handbookPath) },
          localDir: { path: settings.localDir, exists: fs.existsSync(memoryLocalDir(ctx.cwd, settings)) }
        },
        externalPackages: settings.externalPackages,
        rules: [
          "Memory is advisory; repository files and current task contract are authoritative.",
          "Only write durable memory after an explicit user remember request or an approved workflow step.",
          "Do not save secrets, credentials, raw private data, or large source excerpts.",
          "Prefer compact summaries, tags, and links over long transcripts."
        ]
      };
      const text = params.detail === "full"
        ? JSON.stringify(payload, null, 2)
        : [
          `memory: ${payload.enabled ? payload.mode : "off"}`,
          `scope: ${payload.scope}`,
          `summary: ${payload.files.summary.path} (${payload.files.summary.exists ? "exists" : "missing"})`,
          `handbook: ${payload.files.handbook.path} (${payload.files.handbook.exists ? "exists" : "missing"})`,
          `writePolicy: ${payload.writePolicy}`,
          `externalPackages: ${payload.externalPackages.join(", ") || "none"}`
        ].join("\n");
      return { content: [{ type: "text", text }], details: payload };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_memory_note",
    label: "Piagent Memory Note",
    description: "Append an explicit durable project memory note to .pi/memory/MEMORY.md.",
    promptSnippet: "Use only when the user explicitly asks to remember a stable fact, decision, preference, lesson, or open loop.",
    promptGuidelines: [
      "Do not call this for incidental transcript content.",
      "Keep notes compact and evidence-based.",
      "Secrets are redacted before writing, but avoid sending secrets to the tool."
    ],
    parameters: Type.Object({
      category: StringEnum(["preference", "decision", "project", "lesson", "open-loop", "reference"] as const),
      title: Type.String({ minLength: 3 }),
      content: Type.String({ minLength: 3 }),
      source: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      try {
        const result = appendMemoryNote(ctx.cwd, profile, params);
        appendTrace(ctx.cwd, { event: "memory_note", category: params.category, title: params.title, path: result.path, redacted: result.redacted });
        appendSessionTrace(pi, { event: "memory_note", category: params.category, title: params.title, path: result.path, redacted: result.redacted });
        return {
          content: [{ type: "text", text: `Memory note saved: ${result.path}${result.redacted ? " (secrets redacted)" : ""}` }],
          details: result
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Memory note failed: ${message}` }], isError: true };
      }
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_memory_search",
    label: "Piagent Memory Search",
    description: "Keyword-search project memory markdown files.",
    promptSnippet: "Search project memory for relevant durable facts before re-scouting the whole repo.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Number())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const limit = Math.max(1, Math.min(20, Math.trunc(params.limit ?? 10)));
      const matches = searchMemoryFiles(ctx.cwd, profile, params.query, limit);
      const text = matches.length
        ? matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")
        : "No memory matches.";
      return { content: [{ type: "text", text }], details: { query: params.query, matches } };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context_index_status",
    label: "Piagent Context Index Status",
    description: "Return the project context index status, node counts, citations, and stale/pending warnings.",
    promptSnippet: "Use this during project/profile init to check whether the compact context graph is present and fresh.",
    promptGuidelines: [
      "Treat the context index as advisory; verify with current repository files before editing.",
      "Do not use it as a security boundary or as the only source of truth.",
      "If warnings mention pending tech context, refresh via Context7 and record concise snapshots."
    ],
    parameters: Type.Object({
      detail: Type.Optional(StringEnum(["concise", "full"] as const))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const status = buildContextIndexStatus(ctx.cwd, profile);
      const text = params.detail === "full"
        ? JSON.stringify(status, null, 2)
        : [
            `contextIndex: ${status.enabled ? "enabled" : "off"}`,
            `path: ${status.path} (${status.exists ? "exists" : "missing"})`,
            `nodes: ${status.nodes}`,
            `edges: ${status.edges}`,
            `citations: ${status.citations}`,
            `updatedAt: ${status.updatedAt ?? "never"}`,
            `warnings: ${status.warnings.join("; ") || "none"}`
          ].join("\n");
      return { content: [{ type: "text", text }], details: status };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context_index_search",
    label: "Piagent Context Index Search",
    description: "Keyword-search the compact project context index.",
    promptSnippet: "Search the project context index before re-scouting broad repository structure.",
    promptGuidelines: [
      "Use hits as navigation hints only.",
      "Open and verify cited files before changing code."
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Number())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const limit = Math.max(1, Math.min(20, Math.trunc(params.limit ?? 10)));
      try {
        const matches = searchContextIndex(ctx.cwd, profile, params.query, limit);
        const text = matches.length
          ? matches.map((match) => `${match.id} [${match.kind}] ${match.label}: ${match.match}`).join("\n")
          : "No context index matches.";
        return { content: [{ type: "text", text }], details: { query: params.query, matches } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Context index search failed: ${message}` }], isError: true };
      }
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_context_index_record",
    label: "Piagent Context Index Record",
    description: "Persist a compact project context index with cited nodes and edges.",
    promptSnippet: "Record concise profile/project/tech/task context after onboarding or an approved handoff summary.",
    promptGuidelines: [
      "Only record stable, verified, non-secret project facts.",
      "Keep nodes small and cite project files/docs; do not save raw transcripts or large source excerpts.",
      "Memory and context index entries are advisory and must be re-verified before editing."
    ],
    parameters: Type.Object({
      summary: Type.String({ minLength: 10 }),
      source: Type.Optional(StringEnum(["onboarding-record", "approved-workflow", "manual"] as const)),
      sourceFiles: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
        url: Type.Optional(Type.String())
      }))),
      nodes: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        kind: StringEnum(CONTEXT_INDEX_NODE_KINDS),
        label: Type.String({ minLength: 1 }),
        summary: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        citations: Type.Optional(Type.Array(Type.Object({
          path: Type.Optional(Type.String()),
          reason: Type.Optional(Type.String()),
          url: Type.Optional(Type.String())
        })))
      }))),
      edges: Type.Optional(Type.Array(Type.Object({
        from: Type.String({ minLength: 1 }),
        to: Type.String({ minLength: 1 }),
        kind: StringEnum(CONTEXT_INDEX_EDGE_KINDS),
        reason: Type.Optional(Type.String())
      }))),
      citations: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
        url: Type.Optional(Type.String())
      })))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      try {
        const index = writeContextIndex(ctx.cwd, profile, {
          source: params.source ?? "approved-workflow",
          summary: params.summary,
          sourceFiles: params.sourceFiles,
          nodes: params.nodes,
          edges: params.edges,
          citations: params.citations
        });
        appendTrace(ctx.cwd, { event: "context_index_record", path: index.policy.path, nodes: index.nodes.length, edges: index.edges.length, warnings: index.warnings });
        appendSessionTrace(pi, { event: "context_index_record", path: index.policy.path, nodes: index.nodes.length, edges: index.edges.length, warnings: index.warnings });
        return {
          content: [{ type: "text", text: `Context index recorded: ${index.policy.path} (${index.nodes.length} nodes, ${index.edges.length} edges, ${index.citations.length} citations)` }],
          details: index
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Context index record failed: ${message}` }], isError: true };
      }
    }
  });

}
