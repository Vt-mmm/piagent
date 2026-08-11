import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionContext = any;
type ProjectProfile = any;
type TaskContract = any;
type TechOption = any;
type TechStackManifest = any;

export function registerProfileCommands(pi: ExtensionAPI, deps: Record<string, any>): any {
  const {
    TECH_STACK_MANIFEST_FILE, activeSessionTask, appendSessionTrace, appendTrace, buildProfileOptions,
    buildLiveTaskStatus, buildProfileTechOptions, extensionDir, formatLiveTaskStatus, formatTechOptionsText, formatTechSelectionSummary, fs,
    evaluateTaskGate, loadProfileFromContext, normalizeProjectProfileName, normalizeTechSelections, permissionOverrideFromContext, policy,
    projectContextFilePath, projectProfilePath, readJsonFile, readModelRouteEvents, registerPiagentStatusCommand, resolvePermissionProfile,
    runtimeSnapshotCapture, runtimeVersions, selectValueFromUi, techOptionById, techStackPath,
    trajectoryRuntime, writeProfileFromAdapter, writeTechStackSelection
  } = deps;
  function emitProfileStatus(ctx: ExtensionContext, detail = "concise"): void {
    const profile = loadProfileFromContext(ctx);
    const options = buildProfileOptions(extensionDir, ctx.cwd);
    const projectContextExists = fs.existsSync(projectContextFilePath(ctx.cwd));
    const profileExists = fs.existsSync(projectProfilePath(ctx.cwd));
    const profileNames = options.options.map((option) => option.name);
    const content = detail === "list"
      ? [
          "namespace: /profile",
          `current: ${profile.mode ?? profile.projectId ?? "unprofiled"}`,
          `recommended: ${options.recommended}`,
          `profiles: ${profileNames.join(", ")}`,
          "choose: /profile setup",
          "apply: /profile <profile>",
          "tech: /profile tech setup <profile>"
        ].join("\n")
      : [
          `profile: ${profile.mode ?? profile.projectId ?? "unprofiled"}`,
          `recommended: ${options.recommended}`,
          `profileFile: ${profileExists ? "exists" : "missing"}`,
          `projectContext: ${projectContextExists ? "exists" : "missing"}`,
          "next: /profile setup | /profile <profile> | /profile tech"
        ].join("\n");
    pi.sendMessage(
      {
        customType: "piagent-profile-status",
        content,
        display: true,
        details: {
          current: {
            projectId: profile.projectId,
            displayName: profile.displayName,
            mode: profile.mode,
            permissionProfile: profile.permissionProfile
          },
          recommended: options.recommended,
          reason: options.reason,
          profiles: profileNames,
          profileFile: profileExists,
          projectContext: projectContextExists
        }
      },
      { triggerTurn: false }
    );
  }

  function emitProfileTechStatus(ctx: ExtensionContext): void {
    const profile = loadProfileFromContext(ctx);
    const manifest = readJsonFile(techStackPath(ctx.cwd)) as TechStackManifest | undefined;
    const selected = manifest?.selected ?? [];
    const pending = selected.filter((entry) => entry.context7.status !== "recorded").map((entry) => entry.id);
    pi.sendMessage(
      {
        customType: "piagent-profile-tech-status",
        content: [
          `profile: ${profile.mode ?? "unknown"}`,
          `tech: ${selected.length ? selected.map((entry) => `${entry.role}:${entry.id}`).join(", ") : "not configured"}`,
          `manifest: ${fs.existsSync(techStackPath(ctx.cwd)) ? TECH_STACK_MANIFEST_FILE : "missing"}`,
          `context7Pending: ${pending.join(", ") || "none"}`,
          "setup: /profile tech setup"
        ].join("\n"),
        display: true,
        details: {
          profile: profile.mode,
          techStack: profile.techStack,
          manifest
        }
      },
      { triggerTurn: false }
    );
  }

  function emitProfileTechOptions(ctx: ExtensionContext, profileName?: string): void {
    const result = buildProfileTechOptions(extensionDir, ctx.cwd, profileName);
    pi.sendMessage(
      {
        customType: "piagent-profile-tech-options",
        content: formatTechOptionsText(result),
        display: true,
        details: result
      },
      { triggerTurn: false }
    );
  }

  function emitProfileTechRefresh(ctx: ExtensionContext): void {
    const manifest = readJsonFile(techStackPath(ctx.cwd)) as TechStackManifest | undefined;
    pi.sendMessage(
      {
        customType: "piagent-profile-tech-refresh",
        content: manifest
          ? [
              "context7Refresh: pending",
              ...manifest.selected.map((entry) => `- ${entry.id}: query="${entry.context7.query}" → record with piagent_profile_tech_context_record`)
            ].join("\n")
          : "Tech stack manifest missing. Run /profile tech setup first.",
        display: true,
        details: manifest
      },
      { triggerTurn: false }
    );
  }

  function parseProfileTechApplyArgs(raw: string): { profileName?: string; selections: Record<string, string> } {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const selections: Record<string, string> = {};
    let profileName: string | undefined;
    for (const token of tokens) {
      if (/^(tech|apply|use|set|to|setup|wizard)$/i.test(token)) continue;
      const pair = token.match(/^([a-z-]+)=([a-z0-9-]+)$/i);
      if (pair) {
        selections[pair[1].toLowerCase()] = pair[2].toLowerCase();
        continue;
      }
      if (!profileName) profileName = normalizeProjectProfileName(token);
    }
    return { profileName, selections };
  }

  function emitProfileTechApplied(ctx: ExtensionContext, applied: { profile: ProjectProfile; manifest: TechStackManifest }): void {
    ctx.ui.notify(`Profile tech applied: ${applied.manifest.profile}`, "info");
    pi.sendMessage(
      {
        customType: "piagent-profile-tech-applied",
        content: formatTechSelectionSummary(applied.manifest),
        display: true,
        details: applied
      },
      { triggerTurn: false }
    );
  }

  async function applyProfileTechFromCommand(ctx: ExtensionContext, raw: string): Promise<void> {
    const current = loadProfileFromContext(ctx);
    const parsed = parseProfileTechApplyArgs(raw);
    const profileName = parsed.profileName ?? current.mode ?? buildProfileOptions(extensionDir, ctx.cwd).recommended;
    const selected = normalizeTechSelections(ctx.cwd, profileName, parsed.selections, false);
    if (selected.invalid.length || selected.missing.length) {
      ctx.ui.notify("Profile tech apply needs explicit role selections.", "warning");
      emitProfileTechOptions(ctx, profileName);
      return;
    }
    const applied = writeTechStackSelection(extensionDir, ctx.cwd, profileName, selected.options, current.projectId, current.displayName);
    appendTrace(ctx.cwd, { event: "profile_tech_apply_command", profile: profileName, roles: applied.manifest.roles });
    appendSessionTrace(pi, { event: "profile_tech_apply_command", profile: profileName, roles: applied.manifest.roles });
    emitProfileTechApplied(ctx, applied);
  }

  async function runProfileTechWizard(ctx: ExtensionContext, requestedProfile?: string): Promise<void> {
    const current = loadProfileFromContext(ctx);
    const profileOptions = buildProfileOptions(extensionDir, ctx.cwd);
    const profileChoices = profileOptions.options.map((option) => ({
      value: option.name,
      label: `${option.name}${option.recommended ? " (recommended)" : ""}`,
      description: option.description,
      recommended: option.recommended
    }));
    const profileName = requestedProfile
      ? normalizeProjectProfileName(requestedProfile)
      : await selectValueFromUi(ctx, "Select Pi Agent profile", profileChoices, current.mode ?? profileOptions.recommended);
    if (!profileName) {
      ctx.ui.notify("Select UI unavailable; showing profile/tech options.", "warning");
      emitProfileTechOptions(ctx, current.mode ?? profileOptions.recommended);
      return;
    }
    const techPlan = buildProfileTechOptions(extensionDir, ctx.cwd, profileName);
    const selections: TechOption[] = [];
    for (const group of techPlan.roleOptions) {
      const choices = group.options.map((option) => ({
        value: option.id,
        label: `${option.label}${option.id === group.recommended ? " (recommended)" : ""}`,
        description: option.description,
        recommended: option.id === group.recommended
      }));
      const selectedId = await selectValueFromUi(ctx, `Select ${group.role} tech`, choices, group.recommended);
      if (!selectedId) {
        ctx.ui.notify(`Select UI unavailable for ${group.role}; showing exact apply command.`, "warning");
        emitProfileTechOptions(ctx, profileName);
        return;
      }
      const option = techOptionById(selectedId, group.role);
      if (!option) {
        ctx.ui.notify(`Unknown ${group.role} tech: ${selectedId}`, "warning");
        emitProfileTechOptions(ctx, profileName);
        return;
      }
      selections.push(option);
    }
    const applied = writeTechStackSelection(extensionDir, ctx.cwd, profileName, selections, current.projectId, current.displayName);
    appendTrace(ctx.cwd, { event: "profile_tech_wizard_apply", profile: profileName, roles: applied.manifest.roles });
    appendSessionTrace(pi, { event: "profile_tech_wizard_apply", profile: profileName, roles: applied.manifest.roles });
    emitProfileTechApplied(ctx, applied);
  }

  function registerProfileCommand(name: string): void {
    pi.registerCommand(name, {
      description: "Show or apply the current project profile without a model follow-up",
      handler: async (args, ctx) => {
        const raw = String(args ?? "").trim();
        const tokens = raw.split(/\s+/).filter(Boolean);
        const normalized = tokens.map((token) => token.toLowerCase());
        if (normalized[0] === "tech") {
          const action = normalized[1] ?? "status";
          if (["show", "status", "current"].includes(action)) {
            emitProfileTechStatus(ctx);
            return;
          }
          if (["setup", "wizard", "select"].includes(action)) {
            await runProfileTechWizard(ctx, tokens[2]);
            return;
          }
          if (["list", "options", "help"].includes(action)) {
            emitProfileTechOptions(ctx, tokens[2]);
            return;
          }
          if (action === "apply") {
            await applyProfileTechFromCommand(ctx, raw);
            return;
          }
          if (action === "refresh") {
            emitProfileTechRefresh(ctx);
            return;
          }
          emitProfileTechOptions(ctx, tokens.slice(1).join(" "));
          return;
        }
        if (["setup", "wizard", "select"].includes(normalized[0] ?? "")) {
          await runProfileTechWizard(ctx, tokens[1]);
          return;
        }
        if (!tokens.length || ["show", "status", "current"].includes(normalized[0])) {
          emitProfileStatus(ctx);
          return;
        }
        if (["list", "options", "help"].includes(normalized[0])) {
          emitProfileStatus(ctx, "list");
          return;
        }

        const cleaned = tokens.filter((token) => !/^--?(overwrite|replace|force)$/.test(token.toLowerCase()));
        let profileName = cleaned[0];
        let intent: string | undefined;
        if (["apply", "use", "switch", "set", "to"].includes(profileName?.toLowerCase() ?? "")) {
          profileName = cleaned[1];
        } else if (profileName?.toLowerCase() === "intent") {
          intent = cleaned[1];
          profileName = buildProfileOptions(extensionDir, ctx.cwd, intent).recommended;
        } else if (["auto", "recommended", "recommend"].includes(profileName?.toLowerCase() ?? "")) {
          profileName = buildProfileOptions(extensionDir, ctx.cwd).recommended;
        }

        if (!profileName) {
          ctx.ui.notify("Usage: /profile <profile> or /profile auto", "warning");
          emitProfileStatus(ctx, "list");
          return;
        }
        profileName = normalizeProjectProfileName(profileName);

        const currentProfile = loadProfileFromContext(ctx);
        try {
          const applied = writeProfileFromAdapter(
            extensionDir,
            ctx.cwd,
            profileName,
            true,
            currentProfile.projectId,
            currentProfile.displayName
          );
          appendTrace(ctx.cwd, { event: "profile_apply_command", command: name, profile: profileName, projectId: applied.projectId, mode: applied.mode, intent });
          appendSessionTrace(pi, { event: "profile_apply_command", command: name, profile: profileName, projectId: applied.projectId, mode: applied.mode, intent });
          const projectContextExists = fs.existsSync(projectContextFilePath(ctx.cwd));
          ctx.ui.notify(`Profile applied: ${applied.mode ?? profileName}`, "info");
          pi.sendMessage(
            {
              customType: "piagent-profile-applied",
              content: [
                `profile: ${applied.mode ?? profileName}`,
                "updated: .pi/piagent-profile.json",
                "updated: .pi/piagent-profile.lock.json",
            `projectContext: ${projectContextExists ? "exists" : "missing"}${projectContextExists ? "" : " — run /onboard"}`
              ].join("\n"),
              display: true,
              details: {
                profile: applied,
                profileFile: ".pi/piagent-profile.json",
                lockFile: ".pi/piagent-profile.lock.json",
                projectContext: projectContextExists
              }
            },
            { triggerTurn: false }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Profile apply failed: ${message}`, "warning");
          emitProfileStatus(ctx, "list");
        }
      }
    });
  }

  registerProfileCommand("profile");

  registerPiagentStatusCommand(pi, {
    loadProfile: loadProfileFromContext,
    permissionProfile: (ctx, profile) => resolvePermissionProfile(profile as ProjectProfile, policy, permissionOverrideFromContext(ctx)),
    defaultRequiredContext: policy.defaultRequiredContext,
    capture: runtimeSnapshotCapture,
    versions: runtimeVersions,
    effectiveThinkingLevel: () => String(pi.getThinkingLevel()),
    trajectoryStatus: (ctx) => trajectoryRuntime.status(ctx.cwd, (activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined)?.taskRunId),
    taskStatus: (ctx, snapshot) => {
      const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
      const completionGate = task?.trace.outcome === "pending" ? undefined : evaluateTaskGate(ctx.cwd, task, policy);
      const modelRoute = readModelRouteEvents(ctx.cwd).latest?.decision ?? null;
      const details = buildLiveTaskStatus(ctx.cwd, task, ctx.sessionManager.getSessionId(), { trajectory: trajectoryRuntime.status(ctx.cwd, task?.taskRunId), runtime: snapshot, modelRoute, activeToolGroups: pi.getActiveTools(), completionGate });
      return { content: formatLiveTaskStatus(details), details };
    }
  });

  return { emitProfileStatus, emitProfileTechStatus, runProfileTechWizard };
}
