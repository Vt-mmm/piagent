import {
  codexRuntimeCredentialPolicy,
  codexProcessEnvironment,
  controlledCodexFeatures
} from "./benchmark-runtime.js";
import { codexModelName } from "./benchmark-codex.js";
import { verifyBenchmarkCommandIdentity } from "./benchmark-runtime-identity.js";

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

async function checkedVersion(runCommand, packageRoot, command, args, label, env = process.env) {
  let result;
  try { result = await runCommand(command, args, { cwd: packageRoot, timeoutMs: 15_000, env }); }
  catch (error) { fail(`Required command is unavailable: ${label} (${error.message})`); }
  if (result.code !== 0) fail(`Required command failed preflight: ${label} (${result.stderr.trim() || result.signal || `exit ${result.code}`})`);
  return result.stdout.trim();
}

export async function benchmarkPreflight({ runCommand, packageRoot, piCommand, piEnvironment, codexCommand,
  codexCommandIdentity, gitCommand, surfaces, codexBaseline = "stock", codexMode, codexRuntime, model, serviceTier }) {
  if (surfaces.includes("codex-cli") && codexBaseline === "stock") {
    if (codexCommandIdentity?.installationClosure?.kind !== "stock-codex-installation-v1") {
      fail("Stock Codex installation closure is missing or unsupported");
    }
    try { verifyBenchmarkCommandIdentity(codexCommandIdentity, "stock Codex", { fullPackageClosure: true }); }
    catch (error) { fail(`Stock Codex installation closure failed preflight: ${error.message}`); }
  }
  const gitVersion = await checkedVersion(runCommand, packageRoot, gitCommand, ["--version"], "git");
  const piVersion = await checkedVersion(runCommand, packageRoot, piCommand, ["--version"], "pi", piEnvironment);
  let codexVersion;
  let codexAuth;
  let codexDisabledFeatures = [];
  let codexFastModeFeature = null;
  let codexCapability = null;
  if (surfaces.includes("codex-cli")) {
    const codexEnv = codexProcessEnvironment(codexRuntime);
    codexVersion = await checkedVersion(runCommand, packageRoot, codexCommand, ["--version"], "codex", codexEnv);
    let result;
    try { result = await runCommand(codexCommand, ["login", "status"], { cwd: packageRoot, timeoutMs: 15_000, env: codexEnv }); }
    catch (error) { fail(`Codex authentication preflight failed: ${error.message}`); }
    if (result.code === 0) codexAuth = "login-status";
    else if (codexEnv.OPENAI_API_KEY || codexEnv.CODEX_ACCESS_TOKEN) codexAuth = "environment-credential";
    else fail("Codex CLI is not authenticated; run codex login before this benchmark");
    if (codexMode === "controlled") {
      const features = await runCommand(codexCommand, ["features", "list"], { cwd: packageRoot, timeoutMs: 15_000, env: codexEnv });
      if (features.code !== 0) fail("Codex CLI cannot list features required by controlled benchmark mode; update Codex CLI or use --codex-mode native");
      const available = new Set(features.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
      codexDisabledFeatures = controlledCodexFeatures.filter((feature) => available.has(feature));
      codexFastModeFeature = available.has("fast_mode");
      if (serviceTier === "fast" && !codexFastModeFeature) {
        fail("Codex CLI does not expose the fast_mode feature required by this benchmark; update Codex CLI");
      }
      if (codexBaseline === "stock" && !available.has("code_mode_host")) {
        fail("Stock Codex CLI does not expose its required code_mode_host capability");
      }
    }
    const execHelp = await checkedVersion(runCommand, packageRoot, codexCommand, ["exec", "--help"], "codex exec capability", codexEnv);
    codexCapability = {
      schemaVersion: 1,
      providerFree: true,
      model: codexModelName(model),
      jsonl: /--json\b/.test(execHelp),
      workspaceWrite: /workspace-write/.test(execHelp) && /--sandbox\b/.test(execHelp),
      ignoreUserConfig: /--ignore-user-config\b/.test(execHelp),
      ignoreRules: /--ignore-rules\b/.test(execHelp),
      codeModeHost: codexBaseline === "stock"
        ? codexCommandIdentity.installationClosure.files.some(file => file.role === "code-mode-host")
        : null
    };
    if (!codexCapability.jsonl || !codexCapability.workspaceWrite
      || !codexCapability.ignoreUserConfig || !codexCapability.ignoreRules || codexCapability.codeModeHost === false) {
      fail("Codex CLI lacks a provider-free capability required by the benchmark execution contract");
    }
  }
  return { gitVersion, piVersion, codexVersion, codexAuth,
    codexBaseline: surfaces.includes("codex-cli") ? codexBaseline : null,
    codexInstallationDigest: codexCommandIdentity?.installationClosure?.contentDigest ?? null,
    codexCapability,
    codexCredentialPolicy: codexRuntimeCredentialPolicy(codexRuntime),
    codexDisabledFeatures, codexFastModeFeature };
}

function publicCommandIdentity(value) {
  if (!value) return null;
  return {
    contentDigest: value.contentDigest,
    size: value.size,
    executable: value.executable,
    package: value.packageClosure ? {
      name: value.packageClosure.name,
      version: value.packageClosure.version,
      contentDigest: value.packageClosure.tree?.contentDigest ?? null
    } : null,
    ...(value.installationClosure ? { installation: {
      kind: value.installationClosure.kind,
      fileCount: value.installationClosure.files.length,
      contentDigest: value.installationClosure.contentDigest
    } } : {})
  };
}

export function benchmarkPreflightReceipt({
  packageVersion, source, candidateProvenance, suite, suiteDigest,
  runtimeDependencies, webUiAssets, runtimeCommands, environmentPolicy, configurationDigest,
  providerFreeConfigurationDigest = null, rootSeedDigest, options, runtime,
  hostReadinessPolicyDigest = null, hostReadiness = null,
  providerFreeEvidence = null, independentVerification, registeredRuntimeVerifiers = null
}) {
  return {
    schemaVersion: 1,
    kind: "benchmark-provider-free-preflight",
    status: "ready",
    providerSessionsStarted: 0,
    packageVersion,
    source,
    candidateProvenance,
    suite: { id: suite.id, contentDigest: suiteDigest, scenarioCount: suite.scenarios.length },
    configuration: {
      contentDigest: configurationDigest,
      ...(independentVerification ? { independentVerification } : {}),
      ...(providerFreeConfigurationDigest ? { providerFreeContentDigest: providerFreeConfigurationDigest } : {}),
      ...(hostReadinessPolicyDigest ? { hostReadinessPolicyDigest } : {}),
      runtimeDependencyDigest: runtimeDependencies?.digest ?? null,
      ...(webUiAssets ? { webUiAssetDigest: webUiAssets.digest } : {}),
      environmentPolicyDigest: environmentPolicy.digest,
      rootSeedDigest,
      surfaces: options.surfaces,
      model: options.model ?? null,
      thinking: options.thinking ?? null,
      serviceTier: options.serviceTier ?? null,
      codexMode: options.codexMode,
      codexBaseline: options.codexBaseline ?? null,
      piagentTreatment: options.piagentTreatment,
      repeats: options.repeats,
      timeoutSeconds: options.timeoutSeconds,
      infrastructureRetries: options.infrastructureRetries,
      retryDelaySeconds: options.retryDelaySeconds,
      maxSessions: options.maxSessions ?? null,
      stopAfterFailedPair: options.stopAfterFailedPair,
      ...(options.campaignStopPolicy ? { campaignStopPolicy: options.campaignStopPolicy } : {}),
      ...(options.measurementOnly === true ? { measurementOnly: true } : {})
    },
    ...(hostReadiness ? { hostReadiness } : {}),
    ...(providerFreeEvidence ? { providerFreeEvidence } : {}),
    ...(registeredRuntimeVerifiers ? { registeredRuntimeVerifiers } : {}),
    runtime: {
      gitVersion: runtime.gitVersion,
      piVersion: runtime.piVersion,
      codexVersion: runtime.codexVersion ?? null,
      codexAuth: runtime.codexAuth ?? null,
      codexBaseline: runtime.codexBaseline ?? null,
      codexInstallationDigest: runtime.codexInstallationDigest ?? null,
      codexCapability: runtime.codexCapability ?? null,
      codexCredentialPolicy: runtime.codexCredentialPolicy ?? null,
      codexDisabledFeatures: runtime.codexDisabledFeatures,
      codexFastModeFeature: runtime.codexFastModeFeature ?? null,
      commands: Object.fromEntries(Object.entries(runtimeCommands).map(([name, value]) => [name, publicCommandIdentity(value)]))
    },
    usageContract: {
      piagent: "pi-session-jsonl-exact-or-unavailable",
      codexCli: "turn.completed.usage-cache-exclusive-fresh-exact-or-unavailable",
      failedAttempts: "failure-aware-known-or-unknown-paid-attempt"
    },
    claimBoundary: "provider-free-preflight-only; no quality, workflow, token, latency, generalization, or release claim"
  };
}
