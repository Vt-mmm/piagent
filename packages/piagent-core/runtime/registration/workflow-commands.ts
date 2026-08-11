import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionContext = any;

export function registerWorkflowCommands(pi: ExtensionAPI, deps: Record<string, any>): any {
  const {
    FRESH_COMMAND_ACTIONS, FRESH_COMMAND_HELP, ONBOARDING_COMMAND_ACTIONS, WORKFLOW_COMMAND_EXCLUSIONS, buildContextIndexStatus,
    buildUsageSnapshot, commandArgs, emitProfileStatus, emitProfileTechStatus, emitRuntimeMessage,
    fs, loadProfileFromContext, prefixCompletions, projectContextFilePath, projectProfilePath,
    registerRuntimeCommand, resolveMemorySettings, runProfileTechWizard, selectRuntimeAction, sendWorkflowFollowUp,
    shortTaskLabel, techStackPath
  } = deps;
  type WorkflowCommandName = "task" | "scout" | "be-to-fe" | "discuss" | "plan" | "review" | "platform-improve" | "commit" | "pr" | "onboard";

  const WORKFLOW_ALIASES: Record<string, WorkflowCommandName> = {
    task: "task",
    implement: "task",
    scout: "scout",
    audit: "scout",
    "be-to-fe": "be-to-fe",
    befe: "be-to-fe",
    discuss: "discuss",
    clarify: "discuss",
    plan: "plan",
    review: "review",
    "platform-improve": "platform-improve",
    platform: "platform-improve",
    commit: "commit",
    pr: "pr",
    onboard: "onboard",
    "onboard-project": "onboard"
  };

  function workflowChoices(): Array<{ value: string; label: string; description: string; recommended?: boolean }> {
    return [
      { value: "task", label: "Task", description: "Implement a bounded task", recommended: true },
      { value: "scout", label: "Scout", description: "Read-only audit/research" },
      { value: "be-to-fe", label: "BE to FE", description: "Backend read-only, frontend implementation" },
      { value: "discuss", label: "Discuss", description: "Clarify before planning/editing" },
      { value: "plan", label: "Plan", description: "Create an implementation plan" },
      { value: "review", label: "Review", description: "Review diff/source read-only" },
      { value: "commit", label: "Commit", description: "Guarded local commit workflow" },
      { value: "pr", label: "PR", description: "Guarded pull request preparation" },
      { value: "onboard", label: "Onboard", description: "First-read project onboarding scout" },
      { value: "platform-improve", label: "Platform", description: "Improve Pi Agent Platform itself" },
      { value: "help", label: "Help", description: "Show typed workflow forms" }
    ];
  }

  function buildOnboardingWorkflowPrompt(focus: string): string {
    return [
      "Run the Pi Agent Platform first-read onboarding workflow for this repository.",
      "",
      `Optional focus: ${focus.trim() || "whole repository"}`,
      "",
      "Preconditions:",
      "- The operator has logged in and selected the intended model/thinking level.",
      "- Stay read-only except writing Piagent onboarding state through piagent tools.",
      "",
      "Mandatory flow:",
      "1. Call piagent_context with detail=full.",
      "2. If the project is unprofiled, call piagent_profile_options, do a lightweight root scout, recommend a profile, and use piagent_profile_apply only after the operator choice is clear.",
      "3. Prefer /profile setup or piagent_profile_tech_options + piagent_profile_tech_apply for tech stack selection.",
      "4. Re-call piagent_context after profile/tech changes.",
      "5. Call piagent_memory_status and treat memory as advisory.",
      "6. Read AGENTS.md, README/package/build config, required context, docs/architecture files, source map, and verify command definitions. Do not ingest the whole repo.",
      "7. Identify project purpose, stack/runtime, ownership boundaries, high-risk areas, protected paths, verify commands, MCP/tool capabilities, selected tech stack, memory policy, and conventions.",
      "8. Write a concise .pi/project-context.md snapshot and record it with piagent_project_onboarding_record so .pi/context-index.json is generated.",
      "9. Call piagent_context_index_status and report pending/stale warnings.",
      "",
      "Final output: profile, tech stack, context files read, verification matrix, high-risk areas, context-index status, memory status, and any missing operator decisions."
    ].join("\n");
  }

  function emitWorkflowHelp(ctx: ExtensionContext): void {
    emitRuntimeMessage(ctx, "piagent-workflow-help", [
      "namespace: /workflow",
      "daily: /workflow task <request>",
      "readOnly: /workflow scout <area/spec/risk>",
      "beToFe: /workflow be-to-fe <BE spec/change + FE outcome>",
      "clarify: /workflow discuss <rough idea>",
      "plan: /workflow plan <goal>",
      "review: /workflow review <target or diff>",
      "git: /workflow commit [message] | /workflow pr [title]",
      "onboard: /workflow onboard [focus]",
      "aliases still work: /task, /scout, /be-to-fe, /commit, /pr"
    ].join("\n"), { workflows: workflowChoices().map((choice) => choice.value) });
  }

  async function runWorkflowNamespace(raw: string, ctx: ExtensionContext): Promise<void> {
    const { action, rest } = commandArgs(raw);
    if (!action) {
      const chosen = await selectRuntimeAction(ctx, "Piagent workflow", workflowChoices(), "task");
      if (!chosen || chosen === "help") {
        emitWorkflowHelp(ctx);
        return;
      }
      if (chosen === "onboard") {
        sendWorkflowFollowUp(buildOnboardingWorkflowPrompt(""));
        ctx.ui.notify("Workflow launched: onboard", "info");
        return;
      }
      emitRuntimeMessage(ctx, "piagent-workflow-selected", [
        `workflow: ${chosen}`,
        `run: /workflow ${chosen} <request>`,
        "tip: type the request after the workflow name so the agent receives the task in one turn"
      ].join("\n"), { workflow: chosen });
      return;
    }
    const workflow = WORKFLOW_ALIASES[action];
    if (!workflow || workflow === undefined) {
      emitRuntimeMessage(ctx, "piagent-workflow-error", `unknown workflow: ${action}\nRun /workflow help`, { action }, { message: `Unknown workflow: ${action}`, level: "warning" });
      return;
    }
    if (workflow === "onboard") {
      sendWorkflowFollowUp(buildOnboardingWorkflowPrompt(rest));
      ctx.ui.notify("Workflow launched: onboard", "info");
      return;
    }
    if (!rest.trim()) {
      emitRuntimeMessage(ctx, "piagent-workflow-needs-request", [
        `workflow: ${workflow}`,
        `run: /workflow ${workflow} <request>`,
        `alias: /${workflow} <request>`
      ].join("\n"), { workflow });
      return;
    }
    sendWorkflowFollowUp(`/${workflow} ${rest}`);
    ctx.ui.notify(`Workflow launched: ${workflow}`, "info");
  }

  function emitModelOptions(ctx: ExtensionContext): void {
    const snapshot = buildUsageSnapshot(ctx, String(pi.getThinkingLevel()));
    emitRuntimeMessage(ctx, "piagent-model-options", [
      `current: ${snapshot.model}`,
      `thinking: ${snapshot.thinkingLevel}`,
      "selector: /model or Ctrl+L",
      "cycleModel: Ctrl+P / Shift+Ctrl+P",
      "thinkingLevel: Shift+Tab",
      "terminalCatalog: piagent-models",
      "scopeConfig: piagent-model-scope --preset team",
      "codexFamily: openai-codex/gpt-5.4-mini, openai-codex/gpt-5.5, openai-codex/gpt-5.6-luna/sol/terra",
      "claudeFamily: anthropic/claude-haiku, anthropic/claude-sonnet, anthropic/claude-opus, anthropic/claude-fable-5",
      "rule: choose model/thinking by task effort; do not claim savings without benchmark evidence"
    ].join("\n"), snapshot, { message: `Pi model: ${snapshot.model}`, level: "info" });
  }

  function emitPiagentCommandHelp(ctx: ExtensionContext, topic = "overview"): void {
    const normalized = topic.toLowerCase();
    const sections: Record<string, string[]> = {
      overview: [
        "Piagent command surface:",
        "runtime: /workflow | /piagent-inspector | /usage | /context | /permission | /commands | /profile | /memory | /onboard | /fresh",
        "native: /model | /name | /session | /resume | /compact | /mcp",
        "workflow: /workflow task|scout|be-to-fe|review|commit|pr <request>",
        "mcp: /mcp is Pi native; governed MCP checks stay at /piagent-mcp to avoid collision",
        "legacy: /piagent-* commands still work where they existed",
        "principle: runtime commands run immediately; workflows intentionally launch an agent turn"
      ],
      workflow: [
        "Workflow entrypoint:",
        "/workflow",
        "/workflow task <request>",
        "/workflow scout <read-only request>",
        "/workflow be-to-fe <BE spec/change + FE outcome>",
        "/workflow onboard [focus]"
      ],
      usage: [
        "Usage/session:",
        "/usage",
        "/piagent-inspector",
        "/usage history",
        "Pi native: /name <task name>",
        "/fresh task|scout|be-to-fe <request>",
        "native: /session | /resume"
      ],
      context: [
        "Context:",
        "/context",
        "/context index",
        "/context search <keyword>",
        "/context preflight task",
        "/context compact task"
      ],
      permission: [
        "Permission:",
        "/permission",
        "/permission read-only",
        "/permission workspace-write",
        "/permission full-access"
      ],
      model: [
        "Model:",
        "/model or Ctrl+L opens Pi native selector",
        "/model-options shows local Piagent model guidance",
        "Ctrl+P cycles model scope; Shift+Tab cycles thinking"
      ],
      memory: [
        "Memory:",
        "/memory",
        "Memory is explicit-only by default and advisory, not source of truth"
      ],
      mcp: [
        "MCP:",
        "/piagent-mcp opens governed MCP menu",
        "/piagent-mcp status|get|doctor|approve|reject|reset|enable|disable",
        "/mcp remains Pi native MCP panel"
      ],
      subagents: [
        "Subagents:",
        "/subagents-doctor",
        "/subagents-models",
        "/subagents-fleet",
        "/subagent-cost",
        "Daily work should start from /workflow; parent decides bounded subagents when worth token cost"
      ],
      terminal: [
        "Terminal helpers:",
        "piagent-install --stable",
        "piagent-doctor /path/to/project --strict-share",
        "piagent-usage --history --all-projects --days 7 --csv",
        "piagent-mcp --preset core --scope global --replace",
        "piagent-subagents --preset safe"
      ]
    };
    const lines = sections[normalized] ?? sections.overview;
    emitRuntimeMessage(ctx, "piagent-command-help", lines.join("\n"), { topic: normalized, topics: Object.keys(sections) }, { message: `Piagent commands: ${normalized}`, level: "info" });
  }

  async function runPiagentCommandsNamespace(raw: string, ctx: ExtensionContext): Promise<void> {
    const topic = String(raw ?? "").trim().toLowerCase();
    if (topic) {
      emitPiagentCommandHelp(ctx, topic);
      return;
    }
    const chosen = await selectRuntimeAction(ctx, "Piagent commands", [
      { value: "overview", label: "Overview", description: "The simplified command map", recommended: true },
      { value: "workflow", label: "Workflow", description: "Task/scout/review/git/onboard launcher" },
      { value: "usage", label: "Usage/session", description: "Usage, reports, session names, resume" },
      { value: "context", label: "Context", description: "Index/search/preflight/compact" },
      { value: "permission", label: "Permission", description: "Read/write/full access controls" },
      { value: "model", label: "Model", description: "Native model selector and thinking" },
      { value: "mcp", label: "MCP", description: "Governed MCP commands" },
      { value: "subagents", label: "Subagents", description: "Health, fleet, cost" },
      { value: "terminal", label: "Terminal", description: "piagent-* helpers" }
    ], "overview");
    emitPiagentCommandHelp(ctx, chosen ?? "overview");
  }

  function emitOnboardingStatus(ctx: ExtensionContext): void {
    const profile = loadProfileFromContext(ctx);
    const projectContextExists = fs.existsSync(projectContextFilePath(ctx.cwd));
    const techManifestExists = fs.existsSync(techStackPath(ctx.cwd));
    const indexStatus = buildContextIndexStatus(ctx.cwd, profile);
    const memory = resolveMemorySettings(profile);
    emitRuntimeMessage(ctx, "piagent-onboarding-status", [
      `profile: ${profile.mode ?? profile.projectId ?? "unprofiled"}`,
      `profileFile: ${fs.existsSync(projectProfilePath(ctx.cwd)) ? "exists" : "missing"}`,
      `projectContext: ${projectContextExists ? "exists" : "missing"}`,
      `techStack: ${techManifestExists ? "exists" : "missing"}`,
      `contextIndex: ${indexStatus.exists ? `${indexStatus.nodes} nodes` : "missing"}`,
      `memory: ${memory.enabled ? memory.mode : "off"}`,
      "next: /onboard run | /profile setup | /profile tech setup"
    ].join("\n"), { profile, projectContextExists, techManifestExists, indexStatus, memory }, { message: `Onboarding: ${projectContextExists && indexStatus.exists ? "ready" : "pending"}`, level: projectContextExists && indexStatus.exists ? "info" : "warning" });
  }

  async function runOnboardingCommand(raw: string, ctx: ExtensionContext): Promise<void> {
    const { action, rest } = commandArgs(raw);
    if (!action) {
      const chosen = await selectRuntimeAction(ctx, "Piagent onboarding", [
        { value: "status", label: "Status", description: "Profile/context/index readiness", recommended: true },
        { value: "run", label: "Run onboarding scout", description: "Launch the agent workflow to write project context" },
        { value: "profile", label: "Profile status", description: "Show profile options" },
        { value: "setup", label: "Profile + tech setup", description: "Select profile and tech stack" },
        { value: "help", label: "Help", description: "Show typed forms" }
      ], "status");
      if (chosen === "run") {
        sendWorkflowFollowUp(buildOnboardingWorkflowPrompt(""));
        ctx.ui.notify("Workflow launched: onboard", "info");
        return;
      }
      if (chosen === "profile") {
        emitProfileStatus(ctx, "list");
        return;
      }
      if (chosen === "setup") {
        await runProfileTechWizard(ctx);
        return;
      }
      if (chosen === "status") {
        emitOnboardingStatus(ctx);
        return;
      }
      emitRuntimeMessage(ctx, "piagent-onboarding-help", [
        "namespace: /onboard",
        "status: /onboard status",
        "run: /onboard run [focus]",
        "profile: /onboard profile",
        "setup: /onboard setup [profile]",
        "workflow alias: /workflow onboard [focus]"
      ].join("\n"));
      return;
    }
    if (["status", "show", "current"].includes(action)) {
      emitOnboardingStatus(ctx);
      return;
    }
    if (["run", "scout", "start"].includes(action)) {
      sendWorkflowFollowUp(buildOnboardingWorkflowPrompt(rest));
      ctx.ui.notify("Workflow launched: onboard", "info");
      return;
    }
    if (["profile", "profiles"].includes(action)) {
      emitProfileStatus(ctx, "list");
      return;
    }
    if (["setup", "wizard", "select"].includes(action)) {
      await runProfileTechWizard(ctx, rest || undefined);
      return;
    }
    if (["tech", "stack"].includes(action)) {
      emitProfileTechStatus(ctx);
      return;
    }
    if (action === "help") {
      emitRuntimeMessage(ctx, "piagent-onboarding-help", [
        "namespace: /onboard",
        "/onboard status",
        "/onboard run [focus]",
        "/onboard setup [profile]",
        "/workflow onboard [focus]"
      ].join("\n"));
      return;
    }
    sendWorkflowFollowUp(buildOnboardingWorkflowPrompt([action, rest].filter(Boolean).join(" ")));
    ctx.ui.notify("Workflow launched: onboard", "info");
  }

  registerRuntimeCommand(pi, "workflow", {
    description: "One menu for Piagent task, scout, review, git, and onboarding workflows",
    getArgumentCompletions: (prefix: string) => prefixCompletions(
      Object.keys(WORKFLOW_ALIASES).filter((name) => !WORKFLOW_COMMAND_EXCLUSIONS.includes(name)),
      prefix
    ),
    handler: async (args, ctx) => {
      await runWorkflowNamespace(String(args ?? ""), ctx);
    }
  });

  registerRuntimeCommand(pi, "piagent-commands", {
    description: "Legacy alias for /commands",
    handler: async (args, ctx) => runPiagentCommandsNamespace(String(args ?? ""), ctx)
  });

  registerRuntimeCommand(pi, "commands", {
    description: "Runtime command menu/help for Pi Agent Platform; no model follow-up",
    handler: async (args, ctx) => runPiagentCommandsNamespace(String(args ?? ""), ctx)
  });

  registerRuntimeCommand(pi, "model-options", {
    description: "Show Pi model selector/thinking guidance without a model follow-up",
    handler: async (_args, ctx) => {
      emitModelOptions(ctx);
    }
  });

  registerRuntimeCommand(pi, "onboard-project", {
    description: "Legacy alias for /onboard",
    getArgumentCompletions: (prefix: string) => prefixCompletions(ONBOARDING_COMMAND_ACTIONS, prefix),
    handler: async (args, ctx) => runOnboardingCommand(String(args ?? ""), ctx)
  });

  registerRuntimeCommand(pi, "onboard", {
    description: "Runtime onboarding menu; run launches the first-read onboarding workflow",
    getArgumentCompletions: (prefix: string) => prefixCompletions(ONBOARDING_COMMAND_ACTIONS, prefix),
    handler: async (args, ctx) => runOnboardingCommand(String(args ?? ""), ctx)
  });

  async function startFreshWorkflow(workflow: "task" | "scout" | "be-to-fe", args: string, ctx: any) {
    const request = String(args ?? "").trim();
    if (!request) {
      ctx.ui.notify(`Usage: /fresh ${workflow} <request>`, "warning");
      return;
    }

    const label = shortTaskLabel(request);
    const command = `/${workflow} ${request}`;
    const result = await ctx.newSession({
      withSession: async (nextCtx) => {
        pi.setSessionName(`pi:${workflow}:${label}`);
        await nextCtx.sendUserMessage(command);
      }
    });
    if (result.cancelled) {
      ctx.ui.notify(`Fresh ${workflow} session cancelled`, "warning");
    }
  }

  registerRuntimeCommand(pi, "fresh", {
    description: "Open a fresh governed session for task, scout, or BE-to-FE work",
    getArgumentCompletions: (prefix: string) => prefixCompletions(FRESH_COMMAND_ACTIONS, prefix),
    handler: async (args, ctx) => {
      const { action, rest } = commandArgs(String(args ?? ""));
      if (!action || action === "help") {
        emitRuntimeMessage(ctx, "piagent-fresh-help", FRESH_COMMAND_HELP.join("\n"));
        return;
      }
      const workflow = action === "be-to-fe" ? "be-to-fe" : action === "scout" ? "scout" : "task";
      const request = action === "task" || action === "scout" || action === "be-to-fe"
        ? rest
        : [action, rest].filter(Boolean).join(" ");
      await startFreshWorkflow(workflow, request, ctx);
    }
  });

  registerRuntimeCommand(pi, "fresh-task", {
    description: "Legacy alias for /fresh task",
    handler: async (args, ctx) => startFreshWorkflow("task", String(args ?? ""), ctx)
  });

  registerRuntimeCommand(pi, "fresh-scout", {
    description: "Legacy alias for /fresh scout",
    handler: async (args, ctx) => startFreshWorkflow("scout", String(args ?? ""), ctx)
  });

  registerRuntimeCommand(pi, "fresh-be-to-fe", {
    description: "Legacy alias for /fresh be-to-fe",
    handler: async (args, ctx) => startFreshWorkflow("be-to-fe", String(args ?? ""), ctx)
  });
  return { startFreshWorkflow };
}
