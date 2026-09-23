import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const controlledCodexFeatures = [
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "hooks",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies"
];

const codexEnvironmentCredentialKeys = Object.freeze(["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]);
const codexRuntimeCredentialStates = new WeakMap();
const codexCredentialFields = Object.freeze(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]);

export const PIAGENT_BENCHMARK_TREATMENTS = Object.freeze({
  "release-defaults": Object.freeze({}),
  "local-safe": Object.freeze({
    PIAGENT_SOLVER_MODE: "shadow",
    PIAGENT_PHASE_TOOLS: "shadow",
    PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend",
    PIAGENT_EXECUTION_BACKEND: "host"
  }),
  "mechanical-core": Object.freeze({
    PIAGENT_SOLVER_MODE: "shadow", PIAGENT_PHASE_TOOLS: "shadow", PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend", PIAGENT_EXECUTION_BACKEND: "host", PIAGENT_INTELLIGENCE_ENGINE: "off"
  }),
  "intelligence-engine": Object.freeze({
    PIAGENT_SOLVER_MODE: "shadow", PIAGENT_PHASE_TOOLS: "shadow", PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend", PIAGENT_EXECUTION_BACKEND: "host", PIAGENT_INTELLIGENCE_ENGINE: "on"
  }),
  "causal-phase-enforce": Object.freeze({
    PIAGENT_SOLVER_MODE: "shadow",
    PIAGENT_PHASE_TOOLS: "on",
    PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend",
    PIAGENT_EXECUTION_BACKEND: "host"
  }),
  candidate: Object.freeze({
    PIAGENT_SOLVER_MODE: "recommend",
    PIAGENT_PHASE_TOOLS: "on",
    PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend",
    PIAGENT_EXECUTION_BACKEND: "host"
  }),
  "configured-independent-v2": Object.freeze({
    PIAGENT_SOLVER_MODE: "recommend",
    PIAGENT_PHASE_TOOLS: "on",
    PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend",
    PIAGENT_EXECUTION_BACKEND: "host"
  }),
  "feature-off": Object.freeze({
    PIAGENT_SOLVER_MODE: "off",
    PIAGENT_PHASE_TOOLS: "off",
    PIAGENT_AUTO_RECOVERY: "off",
    PIAGENT_HELPERS_MODE: "off",
    PIAGENT_EXECUTION_BACKEND: "host",
    PIAGENT_INTELLIGENCE_ENGINE: "off"
  }),
  "acceptance-diagnostic": Object.freeze({})
});

const strippedEnvironmentKeys = Object.freeze([
  "BASH_ENV", "CDPATH", "ENV", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM",
  "GIT_DIR", "GIT_EXEC_PATH", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_SHALLOW_FILE",
  "GIT_TEMPLATE_DIR", "GIT_WORK_TREE", "GIT_ATTR_NOSYSTEM", "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE",
  "NPM_CONFIG_NODE_OPTIONS", "PROMPT_COMMAND"
]);

export function benchmarkEnvironmentPolicy() {
  const policy = {
    schemaVersion: 1,
    inherited: "operator-environment-minus-piagent-node-loader-git-and-shell-overrides",
    stripped: strippedEnvironmentKeys,
    forced: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", PI_OFFLINE: "1", nodeExecutableDirectoryFirst: true }
  };
  return { ...policy, digest: crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex") };
}

export function benchmarkHostEnvironment(base = process.env) {
  const env = { ...base };
  for (const key of strippedEnvironmentKeys) delete env[key];
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.PI_OFFLINE = "1";
  env.PATH = [path.dirname(process.execPath), ...String(env.PATH ?? "").split(path.delimiter).filter((value) => value && path.resolve(value) !== path.dirname(process.execPath))].join(path.delimiter);
  return env;
}

export function assertBenchmarkLaunchEnvironmentSafe(base = process.env) {
  const active = ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NPM_CONFIG_NODE_OPTIONS"]
    .filter((key) => typeof base[key] === "string" && base[key].trim());
  if (active.length > 0) fail(`Benchmark launch refuses Node code-loading environment overrides: ${active.join(", ")}`);
}

export function benchmarkGitEnvironment(base = process.env) {
  const host = benchmarkHostEnvironment(base);
  const env = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SystemRoot", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    if (host[key] !== undefined) env[key] = host[key];
  }
  return env;
}

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

export function benchmarkEnvironment(extra = {}) {
  const env = benchmarkHostEnvironment();
  for (const key of Object.keys(env)) {
    if (key.startsWith("PIAGENT_")) delete env[key];
  }
  if (process.env.PIAGENT_BENCHMARK_PI_COMMAND && process.env.PIAGENT_BENCHMARK_TASK_FIXTURE) {
    env.PIAGENT_BENCHMARK_TASK_FIXTURE = process.env.PIAGENT_BENCHMARK_TASK_FIXTURE;
  }
  return { ...env, ...extra, PI_OFFLINE: "1" };
}

export function piagentTreatment(id = "release-defaults") {
  const values = PIAGENT_BENCHMARK_TREATMENTS[id];
  if (!values) throw new Error(`Unknown Piagent benchmark treatment: ${id}`);
  return { id, explicit: id !== "release-defaults", environment: { ...values } };
}

export function piagentProcessEnvironment(treatmentId, extra = {}) {
  const treatment = piagentTreatment(treatmentId);
  return benchmarkEnvironment({ ...treatment.environment, ...extra });
}

function operatorCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function stableCodexCredential(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file
    || file.includes("\0")) fail(`${label} path must be canonical and absolute`, 1);
  let resolved, before;
  try { resolved = fs.realpathSync.native(file); before = fs.lstatSync(resolved, { bigint: true }); }
  catch (error) { throw error; }
  if (resolved !== file || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > 2n * 1024n * 1024n
    || typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())
    || (before.mode & 0o077n) !== 0n) fail(`${label} is not one private host-owned regular file`, 1);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true }), bytes = fs.readFileSync(descriptor),
      after = fs.fstatSync(descriptor, { bigint: true }), current = fs.lstatSync(resolved, { bigint: true });
    if (bytes.length !== Number(before.size) || codexCredentialFields.some(name =>
      before[name] !== opened[name] || before[name] !== after[name] || before[name] !== current[name])) {
      fail(`${label} changed while read`, 1);
    }
    return { bytes, identity: Object.freeze({
      ...Object.fromEntries(codexCredentialFields.map(name => [name, before[name]])),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    }) };
  } finally { fs.closeSync(descriptor); }
}

function writeCodexCredential(file, bytes) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.chmodSync(file, 0o600);
  return stableCodexCredential(file, "Controlled Codex credential copy").identity;
}

export function assertCodexRuntimeCredential(runtime, { required = false } = {}) {
  if (runtime?.mode !== "controlled") {
    if (required) fail("Registered measurement requires a controlled frozen Codex credential", 1);
    return;
  }
  const state = codexRuntimeCredentialStates.get(runtime);
  if (!state?.credential) {
    if (required) fail("Registered measurement requires a frozen Codex auth.json copy", 1);
    return;
  }
  let observed;
  try { observed = stableCodexCredential(state.credential.path, "Controlled Codex credential copy").identity; }
  catch (error) { fail(`Controlled Codex credential copy is unavailable: ${error.message}`, 1); }
  if (codexCredentialFields.some(name => observed[name] !== state.credential.identity[name])
    || observed.sha256 !== state.credential.identity.sha256) {
    fail("Controlled Codex credential copy changed after it was frozen", 1);
  }
}

export function codexRuntimeCredentialPolicy(runtime) {
  if (runtime?.mode !== "controlled") return null;
  const state = codexRuntimeCredentialStates.get(runtime);
  if (!state?.credential) return Object.freeze({ source: "environment-or-none",
    environmentCredentials: "inherited", copyIntegrity: "not-applicable",
    perDispatchIntegrity: "not-applicable" });
  return Object.freeze({
    source: state.excludeEnvironmentCredentials ? "frozen-auth-json-snapshot" : "operator-auth-json",
    environmentCredentials: state.excludeEnvironmentCredentials ? "excluded" : "inherited",
    copyIntegrity: "stable-fd-o-excl-fsync",
    perDispatchIntegrity: "exact-private-stat-and-content-match"
  });
}

export function createCodexRuntime(options) {
  if (!options.surfaces.includes("codex-cli")) {
    return { mode: null, home: null, credentialBridge: null, cleanup() {} };
  }
  if (options.codexMode === "native") {
    return { mode: "native", home: null, credentialBridge: "operator-home", cleanup() {} };
  }

  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-codex-home-")));
  try { fs.chmodSync(home, 0o700); } catch { /* Non-POSIX filesystem. */ }
  let credentialBridge = "environment-only";
  const frozenSource = process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT;
  const requireFrozenCredential = Boolean(options.registeredMeasurement);
  if (requireFrozenCredential && !frozenSource) {
    fs.rmSync(home, { recursive: true, force: true });
    fail("Registered measurement requires the frozen Codex auth.json snapshot", 1);
  }
  const sourceAuth = frozenSource || path.join(operatorCodexHome(), "auth.json");
  let credential = null;
  try {
    const source = stableCodexCredential(sourceAuth, "Codex credential source"),
      target = path.join(home, "auth.json"), identity = writeCodexCredential(target, source.bytes);
    credential = Object.freeze({ path: target, identity });
    credentialBridge = frozenSource ? "frozen-auth-json-copy" : "auth-json-copy";
  } catch (error) {
    if (error?.code !== "ENOENT" || requireFrozenCredential) {
      fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
  }
  const runtime = {
    mode: "controlled",
    home,
    credentialBridge,
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); }
  };
  codexRuntimeCredentialStates.set(runtime, Object.freeze({ credential,
    excludeEnvironmentCredentials: Boolean(frozenSource) }));
  assertCodexRuntimeCredential(runtime, { required: requireFrozenCredential });
  return runtime;
}

export function codexProcessEnvironment(runtime, extra = {}) {
  const env = benchmarkEnvironment(extra);
  if (runtime.mode !== "controlled") return env;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_ACCESS_TOKEN") delete env[key];
  }
  for (const key of ["OPENAI_BASE_URL", "OPENAI_API_BASE"]) delete env[key];
  if (codexRuntimeCredentialStates.get(runtime)?.excludeEnvironmentCredentials) {
    for (const key of codexEnvironmentCredentialKeys) delete env[key];
  }
  env.CODEX_HOME = runtime.home;
  return env;
}

export function comparisonSurfaces(options) {
  return {
    baselineSurface: options.surfaces.find((surface) => surface !== "piagent"),
    candidateSurface: "piagent"
  };
}
