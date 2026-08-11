import {
  codexProcessEnvironment,
  controlledCodexFeatures
} from "./benchmark-runtime.js";

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

export async function benchmarkPreflight({ runCommand, packageRoot, piCommand, piEnvironment, codexCommand, gitCommand, surfaces, codexMode, codexRuntime }) {
  const gitVersion = await checkedVersion(runCommand, packageRoot, gitCommand, ["--version"], "git");
  const piVersion = await checkedVersion(runCommand, packageRoot, piCommand, ["--version"], "pi", piEnvironment);
  let codexVersion;
  let codexAuth;
  let codexDisabledFeatures = [];
  if (surfaces.includes("codex-cli")) {
    const codexEnv = codexProcessEnvironment(codexRuntime);
    codexVersion = await checkedVersion(runCommand, packageRoot, codexCommand, ["--version"], "codex", codexEnv);
    let result;
    try { result = await runCommand(codexCommand, ["login", "status"], { cwd: packageRoot, timeoutMs: 15_000, env: codexEnv }); }
    catch (error) { fail(`Codex authentication preflight failed: ${error.message}`); }
    if (result.code === 0) codexAuth = "login-status";
    else if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) codexAuth = "environment-credential";
    else fail("Codex CLI is not authenticated; run codex login before this benchmark");
    if (codexMode === "controlled") {
      const features = await runCommand(codexCommand, ["features", "list"], { cwd: packageRoot, timeoutMs: 15_000, env: codexEnv });
      if (features.code !== 0) fail("Codex CLI cannot list features required by controlled benchmark mode; update Codex CLI or use --codex-mode native");
      const available = new Set(features.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
      codexDisabledFeatures = controlledCodexFeatures.filter((feature) => available.has(feature));
    }
  }
  return { gitVersion, piVersion, codexVersion, codexAuth, codexDisabledFeatures };
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
    } : null
  };
}

export function benchmarkPreflightReceipt({
  packageVersion, source, candidateProvenance, suite, suiteDigest,
  runtimeDependencies, runtimeCommands, environmentPolicy, configurationDigest,
  rootSeedDigest, options, runtime
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
      runtimeDependencyDigest: runtimeDependencies?.digest ?? null,
      environmentPolicyDigest: environmentPolicy.digest,
      rootSeedDigest,
      surfaces: options.surfaces,
      model: options.model ?? null,
      thinking: options.thinking ?? null,
      codexMode: options.codexMode,
      piagentTreatment: options.piagentTreatment,
      repeats: options.repeats,
      timeoutSeconds: options.timeoutSeconds,
      infrastructureRetries: options.infrastructureRetries,
      retryDelaySeconds: options.retryDelaySeconds,
      maxSessions: options.maxSessions ?? null,
      stopAfterFailedPair: options.stopAfterFailedPair
    },
    runtime: {
      gitVersion: runtime.gitVersion,
      piVersion: runtime.piVersion,
      codexVersion: runtime.codexVersion ?? null,
      codexAuth: runtime.codexAuth ?? null,
      codexDisabledFeatures: runtime.codexDisabledFeatures,
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
