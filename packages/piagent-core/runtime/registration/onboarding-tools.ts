import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ProjectContextIndex = any;
type ProjectOnboardingSnapshot = any;
type ProjectProfile = any;
type TechContextSnapshot = any;
type TechStackManifest = any;


export function registerOnboardingTools(pi: ExtensionAPI, deps: Record<string, any>): void {
  const {
    StringEnum, Type, appendSessionTrace, appendTrace, buildContextIndexV2,
    buildProfileOptions, buildProfileTechOptions, digestJson, effectiveProtectedPaths, extensionDir,
    formatTechOptionsText, formatTechSelectionSummary, fs, loadProfileFromContext, normalizeProjectProfileName,
    normalizeTechSelections, nowIso, policy, projectProfilePath, readJsonFile,
    redactBoundedText, redactBoundedTextArray, redactText, redactTextArray, registerPiagentTool,
    safeTaskId, techContextDirPath, techContextFilePath, techContextRelativePath, techStackPath,
    writeContextIndex, writeProfileDocumentWithLock, writeProfileFromAdapter, writeProjectOnboarding, writeTechStackSelection
  } = deps;
  registerPiagentTool(pi, {
    name: "piagent_profile_options",
    label: "Piagent Profile Options",
    description: "List available piagent project profiles and recommend one for the current repository.",
    promptSnippet: "Use this during project onboarding or when switching project task mode.",
    parameters: Type.Object({
      intent: Type.Optional(StringEnum(["general", "frontend-only", "backend-only", "be-readonly-fe", "docs"] as const))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = buildProfileOptions(extensionDir, ctx.cwd, params.intent);
      const text = [
        `recommended: ${result.recommended}`,
        `reason: ${result.reason}`,
        "",
        "| Profile | Recommended | Use when |",
        "|---|---:|---|",
        ...result.options.map((option) => `| ${option.name} | ${option.recommended ? "yes" : "no"} | ${option.description} |`)
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: result
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_profile_apply",
    label: "Piagent Profile Apply",
    description: "Apply a built-in piagent profile to the current project by writing .pi/piagent-profile.json.",
    promptSnippet: "Apply a selected profile during project onboarding or profile switching.",
    promptGuidelines: [
      "Only call after the user has explicitly selected a profile, or when the user explicitly asked to apply the recommended profile.",
      "Use overwrite=true for direct profile-switch commands such as `/profile <profile>`, `/profile apply <profile>`, or explicit replace/overwrite requests.",
      "Do not use overwrite=true for exploratory show/list/status requests."
    ],
    parameters: Type.Object({
      profile: Type.String({ minLength: 1 }),
      overwrite: Type.Optional(Type.Boolean()),
      projectId: Type.Optional(Type.String()),
      displayName: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const ok = await ctx.ui.confirm(
          `Apply piagent profile "${params.profile}" to this project?\n\nThis writes .pi/piagent-profile.json and .pi/piagent-profile.lock.json.`,
          "Piagent profile apply confirmation"
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: `Profile apply denied by operator: ${params.profile}` }],
            isError: true
          };
        }
        const profile = writeProfileFromAdapter(extensionDir, ctx.cwd, params.profile, params.overwrite === true, params.projectId, params.displayName);
        appendTrace(ctx.cwd, { event: "profile_apply", profile: params.profile, projectId: profile.projectId, mode: profile.mode });
        appendSessionTrace(pi, { event: "profile_apply", profile: params.profile, projectId: profile.projectId, mode: profile.mode });
        return {
          content: [{ type: "text", text: `Profile applied: .pi/piagent-profile.json and .pi/piagent-profile.lock.json (${params.profile})` }],
          details: profile
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Profile apply failed: ${message}` }],
          isError: true
        };
      }
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_profile_tech_options",
    label: "Piagent Profile Tech Options",
    description: "Return selectable tech-stack options for a piagent profile family.",
    promptSnippet: "Use this when the operator wants to configure profile tech stack with select-style choices.",
    parameters: Type.Object({
      profile: Type.Optional(Type.String({ minLength: 1 }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = loadProfileFromContext(ctx);
      const profileName = params.profile ?? current.mode ?? buildProfileOptions(extensionDir, ctx.cwd).recommended;
      const result = buildProfileTechOptions(extensionDir, ctx.cwd, profileName);
      return {
        content: [{ type: "text", text: formatTechOptionsText(result) }],
        details: result
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_profile_tech_apply",
    label: "Piagent Profile Tech Apply",
    description: "Apply a profile plus selected tech stack and persist .pi/tech-stack.json with Context7 placeholders.",
    promptSnippet: "Use only after the operator selected profile/tech options.",
    parameters: Type.Object({
      profile: Type.String({ minLength: 1 }),
      frontend: Type.Optional(Type.String()),
      backend: Type.Optional(Type.String()),
      database: Type.Optional(Type.String()),
      mobile: Type.Optional(Type.String()),
      devops: Type.Optional(Type.String()),
      data: Type.Optional(Type.String()),
      docs: Type.Optional(Type.String()),
      runtime: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profileName = normalizeProjectProfileName(params.profile);
      const selected = normalizeTechSelections(ctx.cwd, profileName, params as Record<string, unknown>, false);
      if (selected.invalid.length || selected.missing.length) {
        return {
          content: [{ type: "text", text: `Tech selection incomplete: missing=${selected.missing.join(", ") || "none"} invalid=${selected.invalid.join(", ") || "none"}` }],
          details: buildProfileTechOptions(extensionDir, ctx.cwd, profileName),
          isError: true
        };
      }
      const ok = await ctx.ui.confirm(
        `Apply profile "${profileName}" with selected tech stack?\n\nThis writes .pi/piagent-profile.json, .pi/piagent-profile.lock.json, .pi/tech-stack.json, and .pi/tech-context/*.json placeholders.`,
        "Piagent profile tech apply confirmation"
      );
      if (!ok) {
        return { content: [{ type: "text", text: `Profile tech apply denied by operator: ${profileName}` }], isError: true };
      }
      const current = loadProfileFromContext(ctx);
      const applied = writeTechStackSelection(extensionDir, ctx.cwd, profileName, selected.options, current.projectId, current.displayName);
      appendTrace(ctx.cwd, { event: "profile_tech_apply", profile: profileName, roles: applied.manifest.roles });
      appendSessionTrace(pi, { event: "profile_tech_apply", profile: profileName, roles: applied.manifest.roles });
      return {
        content: [{ type: "text", text: formatTechSelectionSummary(applied.manifest) }],
        details: applied
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_profile_tech_context_record",
    label: "Piagent Profile Tech Context Record",
    description: "Record a concise Context7 evidence snapshot for a selected tech stack entry.",
    promptSnippet: "After reading Context7 docs, record only concise rules/citations; do not store full docs.",
    promptGuidelines: [
      "Use after Context7 MCP returns library docs for a selected tech.",
      "Keep summary short and cite source/title/url when available.",
      "Never record secrets or large copied documentation blocks."
    ],
    parameters: Type.Object({
      techId: Type.String({ minLength: 1 }),
      resolvedLibraryId: Type.Optional(Type.String()),
      summary: Type.String({ minLength: 10 }),
      keyRules: Type.Optional(Type.Array(Type.String())),
      citations: Type.Optional(Type.Array(Type.Object({
        title: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        source: Type.Optional(Type.String())
      })))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manifest = readJsonFile(techStackPath(ctx.cwd)) as TechStackManifest | undefined;
      if (!manifest) {
        return { content: [{ type: "text", text: "Tech stack manifest missing. Run /profile tech setup first." }], isError: true };
      }
      const techId = safeTaskId(params.techId);
      const entry = manifest.selected.find((item) => item.id === techId);
      if (!entry) {
        return { content: [{ type: "text", text: `Tech not selected in manifest: ${techId}` }], isError: true };
      }
      const snapshot: TechContextSnapshot = {
        schemaVersion: 1,
        provider: "context7",
        status: "recorded",
        techId,
        role: entry.role,
        query: entry.context7.query,
        resolvedLibraryId: params.resolvedLibraryId,
        topics: entry.topics,
        retrievedAt: nowIso(),
        summary: redactBoundedText(params.summary, 2000),
        keyRules: redactBoundedTextArray(params.keyRules, 20, 500),
        citations: (params.citations ?? []).slice(0, 12).map((citation) => ({
          title: redactBoundedText(citation.title, 160),
          url: redactBoundedText(citation.url, 300),
          source: redactBoundedText(citation.source, 160)
        }))
      };
      snapshot.digest = digestJson(snapshot);
      fs.mkdirSync(techContextDirPath(ctx.cwd), { recursive: true });
      fs.writeFileSync(techContextFilePath(ctx.cwd, techId), `${JSON.stringify(snapshot, null, 2)}\n`);
      entry.context7.status = "recorded";
      entry.context7.retrievedAt = snapshot.retrievedAt;
      entry.context7.resolvedLibraryId = snapshot.resolvedLibraryId;
      entry.context7.digest = snapshot.digest;
      manifest.updatedAt = nowIso();
      fs.writeFileSync(techStackPath(ctx.cwd), `${JSON.stringify(manifest, null, 2)}\n`);
      // Write back the document the project stores, not the resolved one: saving
      // the resolved copy would inline the adapter and stop it following.
      const stored = readJsonFile(projectProfilePath(ctx.cwd)) as ProjectProfile | undefined;
      if (stored?.techStack) {
        stored.techStack.updatedAt = manifest.updatedAt;
        writeProfileDocumentWithLock(extensionDir, ctx.cwd, stored);
      }
      appendTrace(ctx.cwd, { event: "profile_tech_context_record", techId, role: entry.role, libraryId: snapshot.resolvedLibraryId });
      appendSessionTrace(pi, { event: "profile_tech_context_record", techId, role: entry.role, libraryId: snapshot.resolvedLibraryId });
      return {
        content: [{ type: "text", text: `Tech context recorded: ${techContextRelativePath(techId)}` }],
        details: { manifest, snapshot }
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_project_onboarding_record",
    label: "Piagent Project Onboarding Record",
    description: "Persist the first-run project context snapshot after the selected model has inspected the project.",
    promptSnippet: "Record the reusable project context snapshot after initial repo onboarding.",
    promptGuidelines: [
      "Use after login/model selection and a read-only project scout.",
      "Write concise architecture/context facts only; do not include secrets, tokens, or large source excerpts.",
      "Update .pi/project-context.md when project structure, stack, commands, or domain rules materially change."
    ],
    parameters: Type.Object({
      markdown: Type.String({ minLength: 100 }),
      summary: Type.String({ minLength: 10 }),
      sourceFiles: Type.Array(Type.Object({
        path: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 })
      }), { minItems: 1 }),
      model: Type.Optional(Type.String()),
      updateTriggers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      notes: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const snapshot: ProjectOnboardingSnapshot = {
        schemaVersion: 1,
        projectId: profile.projectId,
        profileMode: profile.mode,
        contextFile: ".pi/project-context.md",
        summary: redactText(params.summary),
        model: params.model ? redactText(params.model) : undefined,
        sourceFiles: params.sourceFiles.map((file) => ({ path: file.path, reason: redactText(file.reason) })),
        updateTriggers: redactTextArray(params.updateTriggers ?? [
          "Project structure changed",
          "Stack/framework changed",
          "Verify commands changed",
          "Domain or ownership rules changed"
        ]),
        notes: params.notes ? redactText(params.notes) : undefined,
        recordedAt: nowIso()
      };
      writeProjectOnboarding(ctx.cwd, snapshot, params.markdown);
      let contextIndex: ProjectContextIndex | undefined;
      let contextIndexError: string | undefined;
      try {
        contextIndex = writeContextIndex(ctx.cwd, profile, {
          source: "onboarding-record",
          summary: snapshot.summary,
          sourceFiles: snapshot.sourceFiles,
          citations: snapshot.sourceFiles
        });
      } catch (error) {
        contextIndexError = error instanceof Error ? error.message : String(error);
      }
      let contextEngine: Awaited<ReturnType<typeof buildContextIndexV2>> | undefined;
      let contextEngineError: string | undefined;
      try {
        const pathPolicy = effectiveProtectedPaths(policy, profile);
        contextEngine = await buildContextIndexV2(ctx.cwd, {
          excludePatterns: Array.from(new Set([
            ...pathPolicy.readProtectedPaths,
            ...pathPolicy.writeProtectedPaths,
            ".pi/context-index.json",
            ".pi/piagent-state/**"
          ]))
        });
      } catch (error) {
        contextEngineError = error instanceof Error ? error.message : String(error);
      }
      appendTrace(ctx.cwd, { event: "project_onboarding_record", contextFile: snapshot.contextFile, sourceFiles: params.sourceFiles, contextIndex: contextIndex?.policy.path, contextIndexError });
      appendSessionTrace(pi, { event: "project_onboarding_record", contextFile: snapshot.contextFile, sourceFiles: params.sourceFiles, contextIndex: contextIndex?.policy.path, contextIndexError });

      return {
        content: [{
          type: "text",
          text: `Project onboarding snapshot recorded: .pi/project-context.md${contextIndex ? ` and ${contextIndex.policy.path}` : contextIndexError ? ` (context index skipped: ${contextIndexError})` : ""}${contextEngine ? `; Context Engine indexed ${contextEngine.files} files / ${contextEngine.symbols} symbols` : contextEngineError ? `; Context Engine skipped: ${contextEngineError}` : ""}`
        }],
        details: { ...snapshot, contextIndex, contextIndexError, contextEngine, contextEngineError }
      };
    }
  });

}
