import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionContext = any;
type PermissionProfileMode = any;
type PermissionProfilesConfig = any;
type ResolvedPermissionProfile = any;

export function registerPermissionCommands(pi: ExtensionAPI, deps: Record<string, any>): void {
  const {
    commandArgs, emitRuntimeMessage, loadProfileFromContext, permissionOverrideFromContext, permissionProfilesConfig,
    policy, resolvePermissionProfile, selectRuntimeAction, sendWorkflowFollowUp, setPermissionOverrideForContext
  } = deps;
  function permissionStatusText(permissionProfile: ResolvedPermissionProfile, config: Required<PermissionProfilesConfig>): string {
    return [
      `permissionProfile: ${permissionProfile.mode}`,
      `source: ${permissionProfile.source}${permissionProfile.requested ? ` (${permissionProfile.requested})` : ""}`,
      `runtimeEquivalent: ${permissionProfile.runtimeEquivalent}`,
      `allowedModes: ${config.allowedModes.join(", ")}`,
      `warning: ${permissionProfile.warning ?? "none"}`,
      "boundaries: protected-paths, secret redaction, capability lock, and destructive/external confirmations remain enforced"
    ].join("\n");
  }

  function emitPermissionStatus(ctx: ExtensionContext, permissionProfile: ResolvedPermissionProfile): void {
    const config = permissionProfilesConfig(policy);
    pi.sendMessage(
      {
        customType: "piagent-permission-profile",
        content: permissionStatusText(permissionProfile, config),
        display: true,
        details: {
          permissionProfile,
          allowedModes: config.allowedModes,
          envOverrideActive: Boolean(process.env.PIAGENT_PERMISSION_PROFILE?.trim()),
          commandOverrideActive: Boolean(permissionOverrideFromContext(ctx)),
          boundaries: {
            protectedPaths: "enforced",
            shellProtectedPaths: "enforced",
            secretRedaction: "enforced",
            capabilityLock: "enforced when profile declares capabilityPacks",
            destructiveExternalConfirmation: "enforced"
          }
        }
      },
      { triggerTurn: false }
    );
  }

  function emitCurrentPermissionStatus(ctx: ExtensionContext): void {
    const profile = loadProfileFromContext(ctx);
    const permissionProfile = resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx));
    ctx.ui.notify(`Piagent permission profile: ${permissionProfile.mode}`, permissionProfile.mode === "trusted-full-access" ? "warning" : "info");
    emitPermissionStatus(ctx, permissionProfile);
  }

  function applyPermissionProfileCommand(ctx: ExtensionContext, mode: PermissionProfileMode, request = ""): void {
    setPermissionOverrideForContext(ctx, mode);
    const profile = loadProfileFromContext(ctx);
    const permissionProfile = resolvePermissionProfile(profile, policy, permissionOverrideFromContext(ctx));
    const isActive = permissionProfile.mode === mode && !permissionProfile.warning;
    const level = !isActive || mode === "trusted-full-access" ? "warning" : "info";
    const message = isActive
      ? `Piagent permission profile set to ${mode} for this session.`
      : `Requested ${mode}, but active profile is ${permissionProfile.mode}.`;
    ctx.ui.notify(message, level);
    if (permissionProfile.warning) ctx.ui.notify(permissionProfile.warning, "warning");
    if (permissionProfile.mode === "trusted-full-access") {
      ctx.ui.notify("Trusted full access is active; protected paths, secret redaction, and destructive/external confirmations remain enforced.", "warning");
    }
    emitPermissionStatus(ctx, permissionProfile);
    if (request.trim()) sendWorkflowFollowUp(request.trim());
  }

  function permissionModeFromAction(action: string): PermissionProfileMode | undefined {
    if (["read", "readonly", "read-only", "ro"].includes(action)) return "read-only";
    if (["write", "workspace", "workspace-write", "ww"].includes(action)) return "workspace-write";
    if (["full", "full-access", "trusted", "trusted-full-access"].includes(action)) return "trusted-full-access";
    return undefined;
  }

  async function runPermissionNamespace(raw: string, ctx: ExtensionContext): Promise<void> {
    const { action, rest } = commandArgs(raw);
    if (!action) {
      const chosen = await selectRuntimeAction(ctx, "Piagent permission", [
        { value: "status", label: "Status", description: "Show current session permission", recommended: true },
        { value: "read-only", label: "Read-only", description: "Scout/review without writes" },
        { value: "workspace-write", label: "Workspace write", description: "Normal governed implementation mode" },
        { value: "full-access", label: "Full access", description: "Trusted local full access; guardrails still apply" },
        { value: "help", label: "Help", description: "Show typed forms" }
      ], "status");
      if (chosen && chosen !== "help") {
        if (chosen === "status") emitCurrentPermissionStatus(ctx);
        else applyPermissionProfileCommand(ctx, permissionModeFromAction(chosen) as PermissionProfileMode);
        return;
      }
      emitRuntimeMessage(ctx, "piagent-permission-help", [
        "namespace: /permission",
        "status: /permission status",
        "read: /permission read-only",
        "write: /permission workspace-write",
        "full: /permission full-access",
        "legacy: /piagent-permission"
      ].join("\n"));
      return;
    }
    if (["status", "show", "current"].includes(action)) {
      emitCurrentPermissionStatus(ctx);
      return;
    }
    if (action === "help") {
      emitRuntimeMessage(ctx, "piagent-permission-help", [
        "namespace: /permission",
        "status: /permission status",
        "read: /permission read-only",
        "write: /permission workspace-write",
        "full: /permission full-access",
        "legacy: /piagent-permission"
      ].join("\n"));
      return;
    }
    const mode = permissionModeFromAction(action);
    if (mode) {
      applyPermissionProfileCommand(ctx, mode, rest);
      return;
    }
    emitRuntimeMessage(ctx, "piagent-permission-error", `unknown permission action: ${action}\nRun /permission help`, { action }, { message: `Unknown permission action: ${action}`, level: "warning" });
  }

  function registerPermissionProfileCommand(
    name: string,
    mode: PermissionProfileMode,
    description: string
  ): void {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        applyPermissionProfileCommand(ctx, mode, String(args ?? ""));
      }
    });
  }

  pi.registerCommand("piagent-permission", {
    description: "Legacy alias for /permission",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["status", "read-only", "workspace-write", "full-access", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runPermissionNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("permission", {
    description: "Show or switch runtime permission without a model follow-up",
    getArgumentCompletions: (prefix: string) => {
      const actions = ["status", "read-only", "workspace-write", "full-access", "help"];
      const typed = String(prefix ?? "").trim().toLowerCase();
      return actions.filter((action) => action.startsWith(typed)).map((action) => ({ value: action, label: action }));
    },
    handler: async (args, ctx) => {
      await runPermissionNamespace(String(args ?? ""), ctx);
    }
  });

  pi.registerCommand("permission-status", {
    description: "Legacy alias for /permission status",
    handler: async (_args, ctx) => {
      emitCurrentPermissionStatus(ctx);
    }
  });

  registerPermissionProfileCommand("read-only", "read-only", "Switch this session to read-only permission profile");
  registerPermissionProfileCommand("workspace-write", "workspace-write", "Switch this session to workspace-write permission profile");
  registerPermissionProfileCommand("full-access", "trusted-full-access", "Switch this session to trusted full-access permission profile");
  registerPermissionProfileCommand("trusted-full-access", "trusted-full-access", "Alias for /full-access");

}
