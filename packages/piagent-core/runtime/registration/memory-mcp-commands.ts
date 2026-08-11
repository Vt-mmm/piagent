import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionContext = any;

export function registerMemoryMcpCommands(pi: ExtensionAPI, deps: Record<string, any>): any {
  const {
    collectServers, emitRuntimeMessage, loadProfileFromContext, mcpActions, mcpApprovalCache,
    resolveMemorySettings, selectValueFromUi
  } = deps;
  function emitMemoryPolicyStatus(ctx: ExtensionContext): void {
    const profile = loadProfileFromContext(ctx);
    const settings = resolveMemorySettings(profile);
    ctx.ui.notify(`Project memory: ${settings.enabled ? settings.mode : "off"}`, "info");
    emitRuntimeMessage(ctx, "piagent-memory-status", [
      `memory: ${settings.enabled ? settings.mode : "off"}`,
      `scope: ${settings.scope}`,
      `summary: ${settings.summaryFile}`,
      `handbook: ${settings.handbookFile}`,
      `writePolicy: ${settings.writePolicy}`,
      "rules: explicit-only by default; current repo files remain source of truth",
      "remember: ask the agent clearly, then it must use piagent_memory_note"
    ].join("\n"), settings);
  }

  pi.registerCommand("piagent-memory", {
    description: "Legacy alias for /memory",
    handler: async (_args, ctx) => {
      emitMemoryPolicyStatus(ctx);
    }
  });

  pi.registerCommand("memory", {
    description: "Show project memory policy and available memory files without a model follow-up",
    handler: async (_args, ctx) => {
      emitMemoryPolicyStatus(ctx);
    }
  });

  pi.registerCommand("memory-policy", {
    description: "Legacy alias for /memory",
    handler: async (_args, ctx) => {
      emitMemoryPolicyStatus(ctx);
    }
  });

  /**
   * MCP management as a command, not as a request to the model.
   *
   * Everything here is also reachable from the `piagent-mcp` terminal CLI. The
   * difference is where you are standing: inside a session, typing the shell
   * command means asking the model to run bash, read the output and tell you
   * what it said — three model turns to answer a question this process can
   * answer from files it has already read. So the same reports are bound to a
   * command, which pi dispatches without involving the model at all.
   *
   * Bare `/piagent-mcp` opens a menu built from what this project actually has,
   * because the surface only helps if you can find it without already knowing
   * the subcommand you want. Every entry in that menu is also typeable, so the
   * menu teaches the direct form rather than replacing it.
   */
  function registerMcpCommand(): void {
    const ACTIONS = new Set([...mcpActions.READ_ACTIONS, ...mcpActions.SERVER_ACTIONS]);

    /** Report without a model turn: the text is shown, nothing is asked. */
    function emit(customType: string, report: { notify: { message: string; level: string }, lines: string[], details: Record<string, unknown> }, ctx: ExtensionContext): void {
      ctx.ui.notify(report.notify.message, report.notify.level as "info" | "warning" | "error");
      pi.sendMessage(
        { customType, content: report.lines.join("\n"), display: true, details: report.details },
        { triggerTurn: false }
      );
    }

    function fail(ctx: ExtensionContext, message: string): void {
      ctx.ui.notify(`piagent-mcp: ${message}`, "error");
      pi.sendMessage(
        { customType: "piagent-mcp-error", content: message, display: true, details: { error: message } },
        { triggerTurn: false }
      );
    }

    /**
     * Approval decisions live outside the repository, so writing one changes no
     * config file the gate's cache is keyed on. Drop the entry so the next tool
     * call re-reads the decision instead of the one it replaced.
     */
    function forgetApprovalCache(cwd: string): void {
      mcpApprovalCache.delete(cwd);
    }

    /** Runs one action and shows it. Both the menu and a typed subcommand land here. */
    function runAction(ctx: ExtensionContext, action: string, name: string | undefined, scope: string | undefined): void {
      const project = ctx.cwd;
      switch (action) {
        case "status":
          emit("piagent-mcp-status", mcpActions.status({ projectPath: project, scope }), ctx);
          return;
        case "get":
          emit("piagent-mcp-detail", mcpActions.detail({ projectPath: project, name: name as string, scope }), ctx);
          return;
        case "doctor":
          emit("piagent-mcp-doctor", mcpActions.doctor({ projectPath: project }), ctx);
          return;
        case "approve":
        case "reject": {
          const report = mcpActions.decide({
            projectPath: project,
            name: name as string,
            decision: action === "approve" ? "approved" : "rejected"
          });
          forgetApprovalCache(project);
          emit("piagent-mcp-decision", report, ctx);
          return;
        }
        case "reset": {
          const report = mcpActions.reset({ projectPath: project, name });
          forgetApprovalCache(project);
          emit("piagent-mcp-decision", report, ctx);
          return;
        }
        case "enable":
        case "disable":
          emit("piagent-mcp-toggle", mcpActions.toggle({
            projectPath: project,
            name: name as string,
            scope,
            enabled: action === "enable"
          }), ctx);
          return;
        default:
          fail(ctx, `unknown subcommand: ${action}. Run /piagent-mcp help.`);
      }
    }

    /**
     * The menu. Falls back to the plain status report when there is no select UI
     * — print mode and JSON mode have no way to answer a prompt, and blocking
     * there would hang a non-interactive run.
     */
    async function runMenu(ctx: ExtensionContext): Promise<void> {
      const menu = mcpActions.menuOptions({ projectPath: ctx.cwd });
      const chosen = ctx.hasUI === false
        ? undefined
        : await selectValueFromUi(ctx, "MCP", menu.entries, menu.entries.find((entry) => entry.recommended)?.value);
      if (!chosen) {
        emit("piagent-mcp-status", mcpActions.status({ projectPath: ctx.cwd }), ctx);
        pi.sendMessage(
          { customType: "piagent-mcp-help", content: mcpActions.HELP_LINES.join("\n"), display: true, details: {} },
          { triggerTurn: false }
        );
        return;
      }
      if (chosen === "help") {
        emit("piagent-mcp-help", mcpActions.help(), ctx);
        return;
      }
      const terminal = mcpActions.terminalOnly(chosen);
      if (terminal) {
        emit("piagent-mcp-terminal", terminal, ctx);
        return;
      }
      if (!mcpActions.SERVER_ACTIONS.has(chosen) || chosen === "reset") {
        // `reset` without a name forgets everything, which is a bigger answer
        // than the menu asked for, so it still picks a server here.
        if (chosen !== "reset") {
          runAction(ctx, chosen, undefined, undefined);
          return;
        }
      }
      const choices = mcpActions.serverChoices({ projectPath: ctx.cwd, action: chosen });
      if (choices.length === 0) {
        fail(ctx, `no server here can be ${chosen === "get" ? "inspected" : `${chosen}d`}.`);
        return;
      }
      const server = choices.length === 1
        ? choices[0].value
        : await selectValueFromUi(ctx, `Which server to ${chosen}?`, choices);
      if (!server) {
        fail(ctx, `no server chosen. Run \`/piagent-mcp ${chosen} <name>\` directly.`);
        return;
      }
      runAction(ctx, chosen, server, undefined);
    }

    pi.registerCommand("piagent-mcp", {
      description: "Show and manage MCP servers, scopes and approvals without a model follow-up",
      getArgumentCompletions: (prefix: string) => {
        const typed = String(prefix ?? "");
        const parts = typed.split(/\s+/);
        if (parts.length <= 1) {
          const items = [...ACTIONS, "help"]
            .filter((name) => name.startsWith(parts[0] ?? ""))
            .map((name) => ({ value: name, label: name }));
          return items.length > 0 ? items : null;
        }
        if (!mcpActions.SERVER_ACTIONS.has(parts[0])) return null;
        let names: string[] = [];
        try {
          names = collectServers({ projectPath: process.cwd() }).map((server) => server.name);
        } catch {
          return null;
        }
        const seen = [...new Set(names)].filter((name) => name.startsWith(parts[parts.length - 1] ?? ""));
        return seen.length > 0 ? seen.map((name) => ({ value: name, label: name })) : null;
      },
      handler: async (args, ctx) => {
        const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        const flags = new Map<string, string>();
        const positionals: string[] = [];
        for (let i = 0; i < tokens.length; i += 1) {
          if (tokens[i] === "--scope" && tokens[i + 1]) {
            flags.set("scope", tokens[i + 1]);
            i += 1;
            continue;
          }
          positionals.push(tokens[i]);
        }
        const requested = (positionals.shift() ?? "").toLowerCase();
        // `list` is what the terminal calls it, and muscle memory arrives here.
        const action = requested === "list" ? "status" : requested;
        const name = positionals[0];
        const scope = flags.get("scope");

        try {
          if (action === "") {
            await runMenu(ctx);
            return;
          }
          if (action === "help" || action === "--help") {
            emit("piagent-mcp-help", mcpActions.help(), ctx);
            return;
          }
          const terminal = mcpActions.terminalOnly(action);
          if (terminal) {
            emit("piagent-mcp-terminal", terminal, ctx);
            return;
          }
          if (!ACTIONS.has(action)) {
            fail(ctx, `unknown subcommand: ${action}. Run /piagent-mcp help.`);
            return;
          }
          if (mcpActions.SERVER_ACTIONS.has(action) && action !== "reset" && !name) {
            fail(ctx, `${action} needs a server name.`);
            return;
          }
          runAction(ctx, action, name, scope);
        } catch (error) {
          fail(ctx, error instanceof Error ? error.message : String(error));
        }
      }
    });
  }
  registerMcpCommand();

}
