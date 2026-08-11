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

export const PIAGENT_BENCHMARK_TREATMENTS = Object.freeze({
  "release-defaults": Object.freeze({}),
  "local-safe": Object.freeze({
    PIAGENT_SOLVER_MODE: "shadow",
    PIAGENT_PHASE_TOOLS: "shadow",
    PIAGENT_AUTO_RECOVERY: "on",
    PIAGENT_HELPERS_MODE: "recommend",
    PIAGENT_EXECUTION_BACKEND: "host"
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
  "feature-off": Object.freeze({
    PIAGENT_SOLVER_MODE: "off",
    PIAGENT_PHASE_TOOLS: "off",
    PIAGENT_AUTO_RECOVERY: "off",
    PIAGENT_HELPERS_MODE: "off",
    PIAGENT_EXECUTION_BACKEND: "host"
  })
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

export function createCodexRuntime(options) {
  if (!options.surfaces.includes("codex-cli")) {
    return { mode: null, home: null, credentialBridge: null, cleanup() {} };
  }
  if (options.codexMode === "native") {
    return { mode: "native", home: null, credentialBridge: "operator-home", cleanup() {} };
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-codex-home-"));
  try { fs.chmodSync(home, 0o700); } catch { /* Non-POSIX filesystem. */ }
  let credentialBridge = "environment-only";
  const sourceAuth = process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT || path.join(operatorCodexHome(), "auth.json");
  try {
    const resolvedAuth = fs.realpathSync(sourceAuth);
    if (!fs.statSync(resolvedAuth).isFile()) fail(`Codex credential path is not a file: ${sourceAuth}`, 1);
    fs.copyFileSync(resolvedAuth, path.join(home, "auth.json"));
    fs.chmodSync(path.join(home, "auth.json"), 0o600);
    credentialBridge = process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT ? "frozen-auth-json-copy" : "auth-json-copy";
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fs.rmSync(home, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    mode: "controlled",
    home,
    credentialBridge,
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); }
  };
}

export function codexProcessEnvironment(runtime, extra = {}) {
  const env = benchmarkEnvironment(extra);
  if (runtime.mode !== "controlled") return env;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_ACCESS_TOKEN") delete env[key];
  }
  for (const key of ["OPENAI_BASE_URL", "OPENAI_API_BASE"]) delete env[key];
  env.CODEX_HOME = runtime.home;
  return env;
}

export function comparisonSurfaces(options) {
  return {
    baselineSurface: options.surfaces.find((surface) => surface !== "piagent"),
    candidateSurface: "piagent"
  };
}
