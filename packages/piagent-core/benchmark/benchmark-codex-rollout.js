import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SERVICE_TIERS = new Set(["default", "fast", "priority"]);
const MAX_ROLLOUT_BYTES = 128 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 100_000;
const EXECUTABLE_DIGEST_CACHE = new Map();

function normalizedTier(value) {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SERVICE_TIERS.has(tier) ? tier : null;
}

function expectedModelId(value) {
  const model = typeof value === "string" ? value.trim() : "";
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function expectedReasoningEffort(value) {
  if (value === "off") return "none";
  if (value === "minimal") return "low";
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pathDigest(value) {
  return sha256(path.resolve(value));
}

function fileIdentity(command) {
  const resolved = fs.realpathSync(command);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("codex-executable-is-not-a-regular-file");
  fs.accessSync(resolved, fs.constants.X_OK);
  const key = `${resolved}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}`;
  const cached = EXECUTABLE_DIGEST_CACHE.get(key);
  if (cached) return cached;
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(resolved, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const identity = {
    pathDigest: sha256(resolved),
    contentDigest: hash.digest("hex"),
    size: stat.size,
    executable: true
  };
  EXECUTABLE_DIGEST_CACHE.set(key, identity);
  return identity;
}

function valuesAfter(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && index + 1 < args.length) values.push(args[index + 1]);
  }
  return values;
}

function countOf(args, value) {
  return args.filter((entry) => entry === value).length;
}

function exactUsage(usage) {
  return usage?.usageCompleteness === "exact"
    && Number.isSafeInteger(usage?.sessions) && usage.sessions === 1
    && Number.isSafeInteger(usage?.fresh) && usage.fresh >= 0
    && Number.isSafeInteger(usage?.input) && Number.isSafeInteger(usage?.output)
    && usage.fresh === usage.input + usage.output;
}

/**
 * Produce a privacy-bounded receipt for the exact Codex argv that was executed.
 * Prompts are supplied on stdin and never enter this receipt. The receipt is
 * intentionally structural: a requested Fast value is not accepted unless the
 * pinned executable ran with strict config, isolated state, the Fast feature,
 * the expected model/effort, and one identity-bound stdout thread start.
 */
export function buildCodexInvocationReceipt({
  command,
  args,
  runtime,
  environment,
  workspace,
  requestedModel,
  requestedThinking,
  requestedServiceTier,
  resumed = false,
  result,
  usage
} = {}) {
  const diagnostics = [];
  const argv = Array.isArray(args) && args.every((entry) => typeof entry === "string") ? [...args] : [];
  const requestedTier = normalizedTier(requestedServiceTier);
  const modelId = expectedModelId(requestedModel);
  const reasoningEffort = expectedReasoningEffort(requestedThinking);
  const expectedWorkspace = typeof workspace === "string" && workspace.trim() ? path.resolve(workspace) : null;
  let executable = null;
  try { executable = fileIdentity(command); }
  catch (error) { diagnostics.push(error instanceof Error ? error.message : "codex-executable-identity-failed"); }

  const controlledHome = runtime?.mode === "controlled" && typeof runtime?.home === "string"
    ? path.resolve(runtime.home)
    : null;
  let isolatedHomeBound = false;
  if (controlledHome) {
    try {
      const stat = fs.lstatSync(controlledHome);
      isolatedHomeBound = stat.isDirectory() && !stat.isSymbolicLink()
        && path.resolve(environment?.CODEX_HOME ?? "") === controlledHome;
    } catch { isolatedHomeBound = false; }
  }
  if (!isolatedHomeBound) diagnostics.push("codex-controlled-home-not-bound");

  const expectedPrefix = resumed ? ["exec", "resume", "--json"] : ["exec", "--json"];
  if (!expectedPrefix.every((value, index) => argv[index] === value)) diagnostics.push("codex-invocation-prefix-mismatch");
  if (countOf(argv, "--strict-config") !== 1) diagnostics.push("codex-strict-config-not-bound");
  if (countOf(argv, "--ignore-user-config") !== 1) diagnostics.push("codex-ignore-user-config-not-bound");
  if (countOf(argv, "--ignore-rules") !== 1) diagnostics.push("codex-ignore-rules-not-bound");
  if (valuesAfter(argv, "-m").length !== 1 || valuesAfter(argv, "-m")[0] !== modelId) {
    diagnostics.push("codex-invocation-model-mismatch");
  }
  const configs = valuesAfter(argv, "-c");
  const expectedReasoningConfig = `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`;
  const expectedTierConfig = `service_tier=${JSON.stringify(requestedTier)}`;
  const expectedSandboxConfig = 'sandbox_mode="workspace-write"';
  const sandboxConfigs = configs.filter((value) => value.startsWith("sandbox_mode="));
  const sandboxModes = valuesAfter(argv, "-s");
  if (configs.filter((value) => value === expectedReasoningConfig).length !== 1
    || configs.filter((value) => value.startsWith("model_reasoning_effort=")).length !== 1) {
    diagnostics.push("codex-invocation-reasoning-mismatch");
  }
  if (configs.filter((value) => value === expectedTierConfig).length !== 1
    || configs.filter((value) => value.startsWith("service_tier=")).length !== 1) {
    diagnostics.push("codex-invocation-service-tier-mismatch");
  }
  const enabledFeatures = valuesAfter(argv, "--enable");
  const disabledFeatures = valuesAfter(argv, "--disable");
  if (requestedTier === "fast") {
    if (enabledFeatures.filter((value) => value === "fast_mode").length !== 1
      || disabledFeatures.includes("fast_mode")) diagnostics.push("codex-fast-feature-not-bound");
  }
  if (argv.at(-1) !== "-") diagnostics.push("codex-stdin-prompt-binding-missing");

  const threadEvidence = usage?.threadStartedEvidence;
  const threadIds = Array.isArray(threadEvidence?.threadIds) ? threadEvidence.threadIds : [];
  const stdoutThreadId = threadIds.length === 1 ? threadIds[0] : null;
  if (threadEvidence?.events !== 1 || !stdoutThreadId || stdoutThreadId !== usage?.providerSessionId) {
    diagnostics.push("codex-stdout-thread-identity-not-bound");
  }
  if (result?.code !== 0 || result?.timedOut === true) diagnostics.push("codex-invocation-did-not-complete");
  if (!exactUsage(usage)) diagnostics.push("codex-invocation-usage-not-exact");

  let workspaceWriteSandboxBound = false;
  if (!resumed) {
    const workspaces = valuesAfter(argv, "-C");
    if (!expectedWorkspace || workspaces.length !== 1 || path.resolve(workspaces[0]) !== expectedWorkspace) {
      diagnostics.push("codex-initial-workspace-argv-mismatch");
    }
    workspaceWriteSandboxBound = sandboxModes.length === 1 && sandboxModes[0] === "workspace-write"
      && sandboxConfigs.length === 0;
    if (!workspaceWriteSandboxBound) diagnostics.push("codex-initial-sandbox-mode-mismatch");
    if (argv.includes("--ephemeral")) diagnostics.push("codex-initial-rollout-not-persistent");
  } else {
    workspaceWriteSandboxBound = configs.filter((value) => value === expectedSandboxConfig).length === 1
      && sandboxConfigs.length === 1 && sandboxModes.length === 0;
    if (!workspaceWriteSandboxBound) diagnostics.push("codex-resume-sandbox-mode-mismatch");
    const expectedThreadId = usage?.providerSessionId;
    if (!expectedThreadId || argv.length < 2 || argv.at(-2) !== expectedThreadId) {
      diagnostics.push("codex-resume-thread-argv-mismatch");
    }
  }

  const homeIdentity = controlledHome ? pathDigest(controlledHome) : null;
  const runtimeIdentityDigest = executable?.contentDigest && homeIdentity
    ? sha256(JSON.stringify({
      mode: runtime?.mode ?? null,
      executableContentDigest: executable.contentDigest,
      homeDigest: homeIdentity,
      credentialBridge: runtime?.credentialBridge ?? null
    }))
    : null;

  return {
    schemaVersion: 1,
    source: "codex-controlled-cli-invocation",
    phase: resumed ? "resume" : "initial",
    valid: diagnostics.length === 0,
    argvDigest: argv.length > 0 ? sha256(JSON.stringify(argv)) : null,
    executable,
    runtime: {
      mode: runtime?.mode ?? null,
      credentialBridge: runtime?.credentialBridge ?? null,
      isolatedHomeBound,
      homeDigest: homeIdentity,
      identityDigest: runtimeIdentityDigest
    },
    bindings: {
      requestedServiceTier: requestedTier,
      effectiveConfigurationTier: requestedTier === "fast" ? "priority" : requestedTier,
      fastModeEnabled: requestedTier === "fast" && enabledFeatures.includes("fast_mode") && !disabledFeatures.includes("fast_mode"),
      strictConfig: countOf(argv, "--strict-config") === 1,
      model: modelId || null,
      reasoningEffort: reasoningEffort || null,
      sandboxMode: workspaceWriteSandboxBound ? "workspace-write" : null,
      workspaceDigest: expectedWorkspace ? pathDigest(expectedWorkspace) : null,
      threadId: stdoutThreadId
    },
    stdout: {
      source: "codex-exec-jsonl-thread-started",
      events: Number(threadEvidence?.events ?? 0),
      threadId: stdoutThreadId
    },
    outcome: {
      exitCode: Number.isInteger(result?.code) ? result.code : null,
      timedOut: result?.timedOut === true,
      usageExact: exactUsage(usage)
    },
    diagnostics
  };
}

function unavailableEvidence(requestedServiceTier, diagnostic) {
  const requested = normalizedTier(requestedServiceTier);
  return {
    schemaVersion: 1,
    source: "codex-controlled-rollout-unavailable",
    events: 0,
    requestedTiers: requested ? [requested] : [],
    observedRequestTiers: [],
    providerResponseTiers: [],
    responseEvidence: ["unavailable-codex-rollout-thread-settings"],
    defaultFallbackEvents: requested === "default" ? 1 : 0,
    commandBindings: requested ? 1 : 0,
    rolloutFiles: 0,
    identityBound: false,
    invocationBound: false,
    coverageBound: false,
    providerStartedEvents: 0,
    invocationEvents: 0,
    initialInvocationEvents: 0,
    resumeInvocationEvents: 0,
    resumeSettingsEvents: 0,
    turnContextEvents: 0,
    diagnostics: [diagnostic]
  };
}

function matchingRolloutFiles(root, threadId) {
  if (!fs.existsSync(root)) return [];
  const pending = [root];
  const matches = [];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_DIRECTORY_ENTRIES) throw new Error("codex-rollout-directory-entry-limit-exceeded");
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) matches.push(target);
    }
  }
  return matches.sort();
}

function threadSettings(event) {
  if (event?.type === "thread_settings_applied" && event.thread_settings && typeof event.thread_settings === "object") {
    return event.thread_settings;
  }
  if (event?.type === "event_msg"
    && event.payload?.type === "thread_settings_applied"
    && event.payload.thread_settings
    && typeof event.payload.thread_settings === "object") return event.payload.thread_settings;
  return null;
}

function turnContext(event) {
  if (event?.type === "turn_context" && event.payload && typeof event.payload === "object") return event.payload;
  if (event?.type === "event_msg" && event.payload?.type === "turn_context"
    && event.payload.turn_context && typeof event.payload.turn_context === "object") return event.payload.turn_context;
  return null;
}

/**
 * Reads the persistent rollout written by a controlled Codex CLI thread and
 * joins it to receipts captured from the actual invocations. Codex writes
 * `thread_settings_applied` only for resume invocations, so the initial turn is
 * proven by strict argv/runtime/stdout identity plus session_meta/turn_context;
 * command config alone is never promoted. The rollout does not expose the
 * provider response body, so response-tier evidence remains absent.
 */
export function inspectCodexRolloutServiceTierEvidence({
  codexHome,
  threadId,
  workspace,
  requestedModel,
  requestedThinking,
  requestedServiceTier,
  providerStartedAttempts,
  invocationReceipts
} = {}) {
  const requested = normalizedTier(requestedServiceTier);
  if (typeof codexHome !== "string" || !codexHome.trim()) {
    return unavailableEvidence(requested, "codex-controlled-home-unavailable");
  }
  if (typeof threadId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(threadId)) {
    return unavailableEvidence(requested, "codex-thread-id-unavailable-or-invalid");
  }

  let files;
  try { files = matchingRolloutFiles(path.join(path.resolve(codexHome), "sessions"), threadId); }
  catch (error) {
    return unavailableEvidence(requested, error instanceof Error ? error.message : "codex-rollout-discovery-failed");
  }
  if (files.length !== 1) {
    return { ...unavailableEvidence(requested, files.length === 0 ? "codex-rollout-not-found" : "codex-rollout-identity-ambiguous"), rolloutFiles: files.length };
  }

  try {
    const file = files[0];
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("codex-rollout-is-not-a-regular-file");
    if (stat.size > MAX_ROLLOUT_BYTES) throw new Error("codex-rollout-size-limit-exceeded");
    const sessionIds = new Set();
    const tiers = [];
    let settingsEvents = 0;
    let sessionMetaEvents = 0;
    let sessionMetaWorkspaceMismatchEvents = 0;
    let turnContextEvents = 0;
    let turnContextModelMismatchEvents = 0;
    let turnContextReasoningMismatchEvents = 0;
    let turnContextWorkspaceMismatchEvents = 0;
    let invalidTierEvents = 0;
    let modelMismatchEvents = 0;
    let reasoningMismatchEvents = 0;
    let workspaceMismatchEvents = 0;
    const modelId = expectedModelId(requestedModel);
    const reasoningEffort = expectedReasoningEffort(requestedThinking);
    const expectedWorkspace = typeof workspace === "string" && workspace.trim() ? path.resolve(workspace) : null;
    for (const [index, rawLine] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      const line = rawLine.trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error(`codex-rollout-invalid-json-line-${index + 1}`); }
      if (event?.type === "session_meta" && typeof event.payload?.id === "string") {
        sessionMetaEvents += 1;
        sessionIds.add(event.payload.id);
        if (!expectedWorkspace || typeof event.payload.cwd !== "string"
          || path.resolve(event.payload.cwd) !== expectedWorkspace) sessionMetaWorkspaceMismatchEvents += 1;
      }
      const context = turnContext(event);
      if (context) {
        turnContextEvents += 1;
        if (!modelId || context.model !== modelId) turnContextModelMismatchEvents += 1;
        if (!reasoningEffort || (context.effort ?? context.reasoning_effort) !== reasoningEffort) {
          turnContextReasoningMismatchEvents += 1;
        }
        if (!expectedWorkspace || typeof context.cwd !== "string" || path.resolve(context.cwd) !== expectedWorkspace) {
          turnContextWorkspaceMismatchEvents += 1;
        }
      }
      const settings = threadSettings(event);
      if (!settings) continue;
      settingsEvents += 1;
      const tier = normalizedTier(settings.service_tier);
      if (tier) tiers.push(tier);
      else invalidTierEvents += 1;
      if (!modelId || settings.model !== modelId) modelMismatchEvents += 1;
      if (!reasoningEffort || settings.reasoning_effort !== reasoningEffort) reasoningMismatchEvents += 1;
      if (!expectedWorkspace || typeof settings.cwd !== "string" || path.resolve(settings.cwd) !== expectedWorkspace) {
        workspaceMismatchEvents += 1;
      }
    }
    if (sessionIds.size !== 1 || !sessionIds.has(threadId)) throw new Error("codex-rollout-thread-identity-mismatch");
    const receipts = Array.isArray(invocationReceipts) ? invocationReceipts : [];
    const expectedProviderStarts = Number.isSafeInteger(providerStartedAttempts) && providerStartedAttempts > 0
      ? providerStartedAttempts
      : 0;
    const initialReceipts = receipts.filter((receipt) => receipt?.phase === "initial");
    const resumeReceipts = receipts.filter((receipt) => receipt?.phase === "resume");
    const expectedHomeDigest = pathDigest(codexHome);
    const executableDigests = new Set(receipts.map((receipt) => receipt?.executable?.contentDigest).filter(Boolean));
    const runtimeIdentityDigests = new Set(receipts.map((receipt) => receipt?.runtime?.identityDigest).filter(Boolean));
    const invocationMismatchEvents = receipts.filter((receipt, index) => {
      const expectedPhase = index === 0 ? "initial" : "resume";
      return receipt?.source !== "codex-controlled-cli-invocation"
        || receipt?.valid !== true
        || receipt.phase !== expectedPhase
        || receipt?.bindings?.requestedServiceTier !== requested
        || receipt?.bindings?.effectiveConfigurationTier !== (requested === "fast" ? "priority" : requested)
        || receipt?.bindings?.fastModeEnabled !== (requested === "fast")
        || receipt?.bindings?.strictConfig !== true
        || receipt?.bindings?.model !== modelId
        || receipt?.bindings?.reasoningEffort !== reasoningEffort
        || receipt?.bindings?.workspaceDigest !== (expectedWorkspace ? pathDigest(expectedWorkspace) : null)
        || receipt?.bindings?.threadId !== threadId
        || receipt?.stdout?.events !== 1
        || receipt?.stdout?.threadId !== threadId
        || receipt?.runtime?.mode !== "controlled"
        || typeof receipt?.runtime?.credentialBridge !== "string"
        || !receipt.runtime.credentialBridge
        || receipt?.runtime?.isolatedHomeBound !== true
        || receipt?.runtime?.homeDigest !== expectedHomeDigest
        || !/^[a-f0-9]{64}$/.test(String(receipt?.runtime?.identityDigest ?? ""))
        || receipt?.outcome?.exitCode !== 0
        || receipt?.outcome?.timedOut !== false
        || receipt?.outcome?.usageExact !== true
        || !/^[a-f0-9]{64}$/.test(String(receipt?.argvDigest ?? ""))
        || !/^[a-f0-9]{64}$/.test(String(receipt?.executable?.pathDigest ?? ""))
        || !/^[a-f0-9]{64}$/.test(String(receipt?.executable?.contentDigest ?? ""))
        || !Number.isSafeInteger(receipt?.executable?.size)
        || receipt.executable.size <= 0
        || receipt?.executable?.executable !== true
        || !Array.isArray(receipt?.diagnostics)
        || receipt.diagnostics.length !== 0;
    }).length;
    const initialInvocationEvents = initialReceipts.filter((receipt) => receipt?.valid === true).length;
    const resumeInvocationEvents = resumeReceipts.filter((receipt) => receipt?.valid === true).length;
    const observedRequestTiers = [...new Set([
      ...(initialInvocationEvents === 1 && requested === "fast" ? ["priority"] : []),
      ...tiers
    ])].sort();
    const diagnostics = [
      sessionMetaEvents !== 1 ? "codex-rollout-session-meta-count-mismatch" : null,
      sessionMetaWorkspaceMismatchEvents > 0 ? "codex-rollout-session-meta-workspace-mismatch" : null,
      expectedProviderStarts === 0 ? "codex-provider-start-count-unavailable" : null,
      receipts.length !== expectedProviderStarts ? "codex-invocation-receipt-coverage-mismatch" : null,
      initialReceipts.length !== 1 ? "codex-initial-invocation-receipt-count-mismatch" : null,
      resumeReceipts.length !== Math.max(0, expectedProviderStarts - 1) ? "codex-resume-invocation-receipt-count-mismatch" : null,
      invocationMismatchEvents > 0 ? "codex-invocation-receipt-mismatch" : null,
      executableDigests.size !== 1 ? "codex-invocation-executable-identity-conflict" : null,
      runtimeIdentityDigests.size !== 1 ? "codex-invocation-runtime-identity-conflict" : null,
      turnContextEvents !== expectedProviderStarts ? "codex-rollout-turn-context-coverage-mismatch" : null,
      turnContextModelMismatchEvents > 0 ? "codex-rollout-turn-context-model-mismatch" : null,
      turnContextReasoningMismatchEvents > 0 ? "codex-rollout-turn-context-reasoning-mismatch" : null,
      turnContextWorkspaceMismatchEvents > 0 ? "codex-rollout-turn-context-workspace-mismatch" : null,
      settingsEvents !== Math.max(0, expectedProviderStarts - 1) ? "codex-rollout-resume-settings-coverage-mismatch" : null,
      invalidTierEvents > 0 ? "codex-rollout-thread-settings-tier-missing-or-invalid" : null,
      observedRequestTiers.length > 1 ? "codex-rollout-service-tier-conflict" : null,
      modelMismatchEvents > 0 ? "codex-rollout-model-mismatch" : null,
      reasoningMismatchEvents > 0 ? "codex-rollout-reasoning-mismatch" : null,
      workspaceMismatchEvents > 0 ? "codex-rollout-workspace-mismatch" : null,
    ].filter(Boolean);
    const coverageBound = expectedProviderStarts > 0
      && receipts.length === expectedProviderStarts
      && initialInvocationEvents === 1
      && resumeInvocationEvents === expectedProviderStarts - 1
      && settingsEvents === expectedProviderStarts - 1
      && turnContextEvents === expectedProviderStarts;
    return {
      schemaVersion: 1,
      source: "codex-controlled-invocation-rollout-settings",
      events: initialInvocationEvents + settingsEvents,
      requestedTiers: requested ? [requested] : [],
      observedRequestTiers,
      providerResponseTiers: [],
      responseEvidence: ["unavailable-codex-rollout-thread-settings"],
      defaultFallbackEvents: tiers.filter((tier) => tier === "default").length + (requested === "default" ? 1 : 0),
      commandBindings: receipts.length,
      rolloutFiles: 1,
      identityBound: true,
      invocationBound: invocationMismatchEvents === 0 && receipts.length > 0,
      coverageBound,
      settingsBound: diagnostics.length === 0,
      providerStartedEvents: expectedProviderStarts,
      invocationEvents: receipts.length,
      initialInvocationEvents,
      resumeInvocationEvents,
      resumeSettingsEvents: settingsEvents,
      turnContextEvents,
      sessionMetaEvents,
      invalidTierEvents,
      modelMismatchEvents,
      reasoningMismatchEvents,
      workspaceMismatchEvents,
      invocationMismatchEvents,
      diagnostics
    };
  } catch (error) {
    return { ...unavailableEvidence(requested, error instanceof Error ? error.message : "codex-rollout-read-failed"), rolloutFiles: 1 };
  }
}
