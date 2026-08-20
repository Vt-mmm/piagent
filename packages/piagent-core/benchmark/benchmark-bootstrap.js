import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { materializeBenchmarkCandidate } from "./benchmark-candidate.js";
import {
  benchmarkPiCredentialFileIdentity,
  benchmarkPiHomeConfigIdentity,
  benchmarkPiHomePublicIdentity,
  copyBenchmarkPiConfigFile,
  recoverBenchmarkPiCredentialWriteback
} from "./benchmark-pi-home.js";
import { benchmarkTreeIdentity } from "./benchmark-tree-identity.js";
import { benchmarkGitEnvironment, benchmarkHostEnvironment } from "./benchmark-runtime.js";

const builtInSuites = new Set(["core-v1", "capability-v1", "e2-framework-v1", "deep-logic-v1", "production-v1"]);
const metadataVariable = "PIAGENT_BENCHMARK_BOOTSTRAP_METADATA";

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function optionValue(argv, name) {
  const index = argv.lastIndexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function runRootFromResume(input, cwd) {
  const target = path.resolve(cwd, input);
  let stat;
  try { stat = fs.statSync(target); }
  catch { fail(`Cannot inspect benchmark resume source: ${target}`); }
  return stat.isDirectory() ? target : path.dirname(target);
}

function jsonFile(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Cannot read ${label} ${file}: ${error.message}`); }
}

export function requestedSuite(argv, cwd, replaySnapshot) {
  const resume = optionValue(argv, "--resume");
  if (resume) {
    const manifestPath = path.join(runRootFromResume(resume, cwd), "run-manifest.json");
    if (!fs.existsSync(manifestPath)) fail(`Cannot resume benchmark: missing run-manifest.json; the root seed cannot be recovered safely`);
    const manifest = jsonFile(manifestPath, "benchmark resume manifest");
    return manifest?.suite?.source ?? manifest?.suite?.manifestPath ?? manifest?.suite?.id ?? "core-v1";
  }
  const replay = optionValue(argv, "--replay-failures");
  if (replay) {
    const report = replaySnapshot?.report ?? jsonFile(path.resolve(cwd, replay), "benchmark replay report");
    return replaySnapshot?.manifest?.suite?.source ?? report?.suite?.source ?? report?.suite?.manifestPath ?? report?.suite?.id ?? "production-v1";
  }
  if (argv.includes("--production")) return "production-v1";
  if (argv.includes("--deep")) return "deep-logic-v1";
  if (argv.includes("--capability")) return "capability-v1";
  return optionValue(argv, "--suite") ?? "core-v1";
}

function snapshotReplay(argv, cwd, temporaryRoot) {
  const input = optionValue(argv, "--replay-failures");
  if (!input) return null;
  const origin = path.resolve(cwd, input);
  let bytes;
  let report;
  try {
    bytes = fs.readFileSync(origin);
    report = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Cannot snapshot benchmark replay report ${origin}: ${error.message}`);
  }
  const replayRoot = path.join(temporaryRoot, "replay");
  fs.mkdirSync(replayRoot, { recursive: true, mode: 0o700 });
  const snapshot = path.join(replayRoot, "report.json");
  fs.writeFileSync(snapshot, bytes, { mode: 0o400 });
  const siblings = {};
  let manifest;
  for (const name of ["run-manifest.json", "runs.jsonl"]) {
    const source = path.join(path.dirname(origin), name);
    if (!fs.existsSync(source)) continue;
    const target = path.join(replayRoot, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o400);
    siblings[name] = target;
    if (name === "run-manifest.json") manifest = jsonFile(target, "benchmark replay manifest");
  }
  return {
    origin,
    snapshot,
    report,
    manifest,
    digest: crypto.createHash("sha256").update(bytes).digest("hex"),
    evidenceComplete: Boolean(siblings["run-manifest.json"] && siblings["runs.jsonl"])
  };
}

function resolveSuiteManifest(source, cwd) {
  if (builtInSuites.has(source)) return { origin: source, manifest: null };
  const target = path.resolve(cwd, source);
  let stat;
  try { stat = fs.statSync(target); }
  catch (error) { fail(`Cannot snapshot benchmark suite ${target}: ${error.message}`); }
  const manifest = stat.isDirectory() ? path.join(target, "suite.json") : target;
  if (!fs.statSync(manifest).isFile()) fail(`Benchmark suite manifest is not a file: ${manifest}`);
  return { origin: fs.realpathSync(manifest), manifest: fs.realpathSync(manifest) };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalProspective(input) {
  const suffix = [];
  let current = path.resolve(input);
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) fail(`Cannot resolve benchmark path: ${input}`);
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function validateOutputIsolation(argv, cwd, repositoryRoot, suiteManifest) {
  const resume = optionValue(argv, "--resume");
  const requested = resume
    ? runRootFromResume(resume, cwd)
    : optionValue(argv, "--output") ? path.resolve(cwd, optionValue(argv, "--output")) : null;
  if (!requested) return;
  const output = canonicalProspective(requested);
  if (suiteManifest && inside(path.dirname(suiteManifest), output)) {
    fail("Benchmark output must not be nested inside the custom suite source");
  }
  if (inside(repositoryRoot, output)) {
    const relative = path.relative(repositoryRoot, output);
    try {
      execFileSync("git", ["-C", repositoryRoot, "check-ignore", "-q", "--no-index", "--", relative], { stdio: "ignore", env: benchmarkGitEnvironment() });
    } catch {
      fail(`Benchmark output inside the candidate repository must be Git-ignored: ${relative}`);
    }
  }
}

function copyTree(source, target) {
  const pending = [[source, target]];
  while (pending.length > 0) {
    const [from, to] = pending.pop();
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const sourcePath = path.join(from, entry.name);
      const targetPath = path.join(to, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink()) fail(`Benchmark suite snapshot rejects symbolic link: ${sourcePath}`);
      if (stat.isDirectory()) pending.push([sourcePath, targetPath]);
      else if (stat.isFile()) fs.copyFileSync(sourcePath, targetPath);
      else fail(`Benchmark suite snapshot rejects unsupported file type: ${sourcePath}`);
    }
  }
}

function chmodTree(root, writable) {
  if (!fs.existsSync(root)) return;
  const pending = [root];
  const directories = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      directories.push(current);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      continue;
    }
    try { fs.chmodSync(current, writable ? 0o600 : (stat.mode & 0o111) !== 0 ? 0o555 : 0o444); } catch { /* Non-POSIX filesystem. */ }
  }
  for (const directory of (writable ? directories : directories.reverse())) {
    try { fs.chmodSync(directory, writable ? 0o700 : 0o555); } catch { /* Non-POSIX filesystem. */ }
  }
}

function dependencyPackagePath(root, name) {
  return path.join(root, "node_modules", ...name.split("/"), "package.json");
}

function runtimeDependencies(candidateRoot, resolutionRoot) {
  const manifest = jsonFile(path.join(candidateRoot, "package.json"), "candidate package manifest");
  const names = [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {})
  ])].sort();
  const packages = {};
  for (const name of names) {
    const packagePath = dependencyPackagePath(resolutionRoot, name);
    let version = null;
    if (fs.existsSync(packagePath)) version = jsonFile(packagePath, `runtime dependency ${name}`).version ?? null;
    packages[name] = version;
  }
  const nodeModulesRoot = path.join(resolutionRoot, "node_modules");
  const identity = {
    schemaVersion: 2,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    packages,
    resolutionRoot: nodeModulesRoot,
    resolutionTree: null,
    isolation: "outside-repo-snapshot; suite-static-import-graph-bound; provider-host-closure-bound"
  };
  return {
    ...identity,
    digest: crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  };
}

function writeBoundJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  fs.writeFileSync(file, bytes, { mode: 0o400 });
  return { path: file, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function credentialMetadata(configRoot) {
  const file = path.join(configRoot, "auth.json");
  if (!fs.existsSync(file)) return [];
  let auth;
  try { auth = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Pi auth snapshot is not valid JSON: ${error.message}`); }
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) fail("Pi auth snapshot has an unsupported shape");
  return Object.entries(auth).map(([providerId, value]) => {
    const type = value && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string" ? value.type : "unknown";
    let readiness = "runtime-validated";
    if (type === "api_key") readiness = typeof value.key === "string" && value.key.length > 0 ? "stored-api-key" : "unusable";
    if (type === "oauth") {
      const current = typeof value.access === "string" && value.access.length > 0 && (!Number.isFinite(value.expires) || value.expires > Date.now());
      const refreshable = typeof value.refresh === "string" && value.refresh.length > 0;
      readiness = current ? "stored-oauth-current" : refreshable ? "stored-oauth-refreshable" : "unusable";
    }
    return { providerId, type, readiness };
  }).sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function piAuthInvocation(argv, cwd, replay) {
  const resume = optionValue(argv, "--resume");
  if (resume) {
    const manifestPath = path.join(runRootFromResume(resume, cwd), "run-manifest.json");
    if (!fs.existsSync(manifestPath)) fail("Cannot resume benchmark: missing run-manifest.json; the root seed cannot be recovered safely");
    const manifest = jsonFile(manifestPath, "benchmark resume manifest");
    if (argv.includes("--allow-pi-auth-writeback") && manifest.allowPiAuthWriteback !== true) {
      fail("Cannot expand Pi OAuth writeback authority while resuming an existing benchmark");
    }
    if (!/^[a-f0-9]{32}$/.test(String(manifest.piCredentialVaultId ?? ""))) fail("Cannot resume benchmark: private Pi credential vault identity is missing or unsupported");
    return { authorized: manifest.allowPiAuthWriteback === true, model: manifest.model ?? null, vaultId: manifest.piCredentialVaultId };
  }
  return {
    authorized: argv.includes("--allow-pi-auth-writeback"),
    model: optionValue(argv, "--model") ?? replay?.manifest?.model ?? replay?.report?.environment?.requestedModel ?? null,
    vaultId: crypto.randomBytes(16).toString("hex")
  };
}

function requestedPiProvider(model, configRoot, credentials) {
  if (typeof model === "string" && model.includes("/")) return model.split("/", 1)[0];
  const settings = path.join(configRoot, "settings.json");
  if (fs.existsSync(settings)) {
    const provider = jsonFile(settings, "Pi settings snapshot")?.defaultProvider;
    if (typeof provider === "string" && provider.length > 0) return provider;
  }
  return credentials.length === 1 ? credentials[0].providerId : null;
}

function snapshotPiAgentHome(temporaryRoot, runtimeParent, argv, cwd, replay) {
  const sourceRoot = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const configRoot = path.join(temporaryRoot, "pi-agent-config");
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of ["auth.json", "models.json"]) {
    const source = path.join(sourceRoot, name);
    const configTarget = path.join(configRoot, name);
    try { copyBenchmarkPiConfigFile(source, configTarget, 0o400); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    copied.push(name);
  }
  writeBoundJson(path.join(configRoot, "settings.json"), {});
  fs.chmodSync(configRoot, 0o500);
  fs.chmodSync(runtimeParent, 0o700);
  const seedIdentity = benchmarkPiHomeConfigIdentity(configRoot, { requiredFileMode: "400" });
  const credentialReadiness = credentialMetadata(configRoot);
  const invocation = piAuthInvocation(argv, cwd, replay);
  const requestedProvider = requestedPiProvider(invocation.model, configRoot, credentialReadiness);
  const operatorAuthPath = path.join(sourceRoot, "auth.json");
  const operatorAuth = copied.includes("auth.json") ? {
    path: operatorAuthPath,
    identity: benchmarkPiCredentialFileIdentity(path.join(configRoot, "auth.json"))
  } : null;
  const identity = {
    ...benchmarkPiHomePublicIdentity(configRoot, credentialReadiness.map(({ providerId, type }) => ({ providerId, type }))),
    settingsPolicy: "deterministic-empty",
    operatorPackagesAndResources: "excluded"
  };
  return {
    configRoot,
    runtimeParent,
    vaultRoot: path.join(sourceRoot, ".piagent-benchmark-vaults"),
    vaultId: invocation.vaultId,
    defaultOutputRoot: path.join(sourceRoot, "benchmarks", "piagent"),
    copied,
    globalInstructions: "excluded",
    authRefreshPolicy: "explicit-same-account-oauth-refresh-cas-writeback",
    writebackAuthorized: invocation.authorized,
    requestedProvider,
    operatorAuth,
    identity,
    credentialReadiness,
    seedIdentity
  };
}

function snapshotCodexCredential(temporaryRoot) {
  const source = path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), "auth.json");
  if (!fs.existsSync(source)) return null;
  if (!fs.statSync(source).isFile()) fail(`Codex credential is not a regular file: ${source}`);
  const targetRoot = path.join(temporaryRoot, "codex-credential");
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const target = path.join(targetRoot, "auth.json");
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o400);
  fs.chmodSync(targetRoot, 0o500);
  return {
    path: target,
    privateIdentity: benchmarkTreeIdentity(targetRoot, { rejectSymlinks: true }),
    identity: { schemaVersion: 1, credentialPresent: true, contentBinding: "private-runtime-only" }
  };
}

function requestsCodexSurface(argv, cwd, replay) {
  const explicit = optionValue(argv, "--surfaces");
  if (explicit) return explicit.split(",").map((value) => value.trim()).includes("codex-cli");
  const resume = optionValue(argv, "--resume");
  if (resume) {
    const manifestPath = path.join(runRootFromResume(resume, cwd), "run-manifest.json");
    return fs.existsSync(manifestPath) && jsonFile(manifestPath, "benchmark resume manifest")?.surfaces?.includes("codex-cli") === true;
  }
  return replay?.manifest?.surfaces?.includes("codex-cli") === true;
}

function isolatedSnapshotParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-snapshot-"));
}

function isolatedPiRuntimeParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-pi-runtime-"));
}

function gitSourceIdentity(root) {
  const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], env: benchmarkGitEnvironment() });
  let commit;
  let status;
  try {
    commit = run(["rev-parse", "HEAD"]).toString("utf8").trim();
    status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch (error) {
    fail(`Cannot capture benchmark Git source identity: ${error.message}`);
  }
  return {
    kind: "git-working-tree",
    commit,
    dirty: status.length > 0,
    statusDigest: crypto.createHash("sha256").update(status).digest("hex")
  };
}

export function createBenchmarkExecutionSnapshot({ liveRoot, argv, cwd }) {
  const root = fs.realpathSync(liveRoot);
  let temporaryRoot;
  let runtimeParent;
  try {
    temporaryRoot = isolatedSnapshotParent();
    runtimeParent = isolatedPiRuntimeParent();
  } catch (error) {
    cleanupBenchmarkExecutionSnapshot(temporaryRoot, runtimeParent);
    fail(`Cannot create an isolated benchmark snapshot: ${error.message}`);
  }
  try {
    const sourceIdentityBefore = gitSourceIdentity(root);
    const candidateRoot = path.join(temporaryRoot, "candidate");
    const candidate = materializeBenchmarkCandidate(root, candidateRoot);
    const sourceIdentityAfter = gitSourceIdentity(root);
    if (JSON.stringify(sourceIdentityBefore) !== JSON.stringify(sourceIdentityAfter)) {
      fail("Benchmark Git source identity changed while the candidate snapshot was being created");
    }
    const candidateIndex = writeBoundJson(path.join(temporaryRoot, "candidate-index.json"), candidate.index);
    const replay = snapshotReplay(argv, cwd, temporaryRoot);
    const piAgentHome = snapshotPiAgentHome(temporaryRoot, runtimeParent, argv, cwd, replay);
    const codexCredential = requestsCodexSurface(argv, cwd, replay) ? snapshotCodexCredential(temporaryRoot) : null;
    const suite = resolveSuiteManifest(requestedSuite(argv, cwd, replay), cwd);
    validateOutputIsolation(argv, cwd, root, suite.manifest);
    let suiteSnapshot = null;
    let suiteRoot;
    if (suite.manifest) {
      const sourceRoot = path.dirname(suite.manifest);
      const targetRoot = path.join(temporaryRoot, "suite");
      copyTree(sourceRoot, targetRoot);
      chmodTree(targetRoot, false);
      suiteSnapshot = path.join(targetRoot, path.basename(suite.manifest));
      suiteRoot = targetRoot;
    } else {
      suiteRoot = path.join(candidateRoot, "benchmarks", suite.origin);
    }
    const metadata = {
      schemaVersion: 1,
      liveRoot: root,
      snapshotRoot: candidateRoot,
      originalCwd: cwd,
      sourceIdentity: sourceIdentityAfter,
      defaultOutputRoot: piAgentHome.defaultOutputRoot,
      candidateProvenance: candidate.provenance,
      candidateIndex,
      runtimeDependencies: runtimeDependencies(candidateRoot, root),
      piAgentHome,
      codexCredential,
      replay: replay ? {
        origin: replay.origin,
        snapshot: replay.snapshot,
        digest: replay.digest,
        evidenceComplete: replay.evidenceComplete
      } : null,
      suite: {
        origin: suite.origin,
        snapshot: suiteSnapshot,
        identity: benchmarkTreeIdentity(suiteRoot, { rejectSymlinks: true })
      }
    };
    return { temporaryRoot, runtimeParent, candidateRoot, metadata };
  } catch (error) {
    cleanupBenchmarkExecutionSnapshot(temporaryRoot, runtimeParent);
    throw error;
  }
}

export function cleanupBenchmarkExecutionSnapshot(temporaryRoot, runtimeParent, piAgentHome) {
  let recoveryError;
  if (piAgentHome) {
    try { recoverBenchmarkPiCredentialWriteback(piAgentHome); }
    catch { recoveryError = new Error("Private Pi OAuth refresh could not be reconciled safely; the credential vault was retained"); }
  }
  for (const root of [temporaryRoot, ...(recoveryError ? [] : [runtimeParent])]) {
    if (!root || !fs.existsSync(root)) continue;
    chmodTree(root, true);
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (recoveryError) throw recoveryError;
}

export function benchmarkBootstrapEnvironment(metadata, base = process.env) {
  const environment = benchmarkHostEnvironment(base);
  delete environment.PI_CODING_AGENT_DIR;
  return {
    ...environment,
    ...(metadata.codexCredential ? { PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT: metadata.codexCredential.path } : {}),
    [metadataVariable]: Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url")
  };
}

export function benchmarkBootstrapMetadata(env = process.env) {
  const encoded = env[metadataVariable];
  if (!encoded) return null;
  let value;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { fail("Benchmark bootstrap metadata is malformed"); }
  if (
    value?.schemaVersion !== 1
    || typeof value.liveRoot !== "string"
    || typeof value.snapshotRoot !== "string"
    || value.sourceIdentity?.kind !== "git-working-tree"
    || !/^[a-f0-9]{40,64}$/.test(String(value.sourceIdentity?.commit ?? ""))
    || typeof value.sourceIdentity?.dirty !== "boolean"
    || !/^[a-f0-9]{64}$/.test(String(value.sourceIdentity?.statusDigest ?? ""))
    || !value.candidateProvenance
    || typeof value.defaultOutputRoot !== "string"
    || typeof value.candidateIndex?.path !== "string"
    || !/^[a-f0-9]{64}$/.test(String(value.candidateIndex?.digest ?? ""))
    || typeof value.runtimeDependencies?.digest !== "string"
    || typeof value.piAgentHome?.configRoot !== "string"
    || typeof value.piAgentHome?.runtimeParent !== "string"
    || typeof value.piAgentHome?.vaultRoot !== "string"
    || !/^[a-f0-9]{32}$/.test(String(value.piAgentHome?.vaultId ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.piAgentHome?.identity?.behavioralDigest ?? ""))
    || typeof value.piAgentHome?.seedIdentity?.contentDigest !== "string"
    || !Array.isArray(value.piAgentHome?.credentialReadiness)
    || typeof value.piAgentHome?.writebackAuthorized !== "boolean"
    || (value.piAgentHome?.requestedProvider !== null && typeof value.piAgentHome?.requestedProvider !== "string")
    || (value.piAgentHome?.operatorAuth !== null && (
      typeof value.piAgentHome?.operatorAuth?.path !== "string"
      || !/^[a-f0-9]{64}$/.test(String(value.piAgentHome?.operatorAuth?.identity?.contentDigest ?? ""))
    ))
    || (value.codexCredential !== null && (
      typeof value.codexCredential?.path !== "string"
      || typeof value.codexCredential?.privateIdentity?.contentDigest !== "string"
    ))
    || typeof value.suite?.origin !== "string"
    || typeof value.suite?.identity?.contentDigest !== "string"
    || (value.replay !== null && (
      typeof value.replay?.snapshot !== "string"
      || !/^[a-f0-9]{64}$/.test(String(value.replay?.digest ?? ""))
      || typeof value.replay?.evidenceComplete !== "boolean"
    ))
  ) fail("Benchmark bootstrap metadata has an unsupported shape");
  return value;
}

export function benchmarkBootstrapCandidateIndex(metadata) {
  let bytes;
  try { bytes = fs.readFileSync(metadata.candidateIndex.path); }
  catch (error) { fail(`Cannot read benchmark candidate snapshot index: ${error.message}`); }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== metadata.candidateIndex.digest) fail("Benchmark candidate snapshot index digest changed");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { fail("Benchmark candidate snapshot index is malformed"); }
  if (!Array.isArray(value)) fail("Benchmark candidate snapshot index has an unsupported shape");
  return value;
}
