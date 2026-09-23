import { isScopedDocsPolicy, validateScopedDocsPolicy, scopedDocsPlanBinding, prepareScopedDocsAttempt,
  runScopedDocsVerification, SCOPED_DOCS_RECEIPT, SCOPED_DOCS_WORKER, DOCS_COMMAND_IDS } from "./benchmark-scoped-docs-verifier.mjs";
import { validateProjectReceipt } from "./benchmark-scoped-project-verification-receipt.mjs";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

export const SCOPED_PROJECT_VERIFICATION_PROTOCOL = "scoped-project-verifier-v1";
export const SCOPED_PROJECT_VERIFICATION_RECEIPT = "scoped-project-verification-receipt-v2";
export const SCOPED_PROJECT_VERIFIER_POLICY = "scoped-project-verifier-policy-v1";
export const SCOPED_PROJECT_VERIFIER_WORKER = "scoped-project-verifier-worker-v1";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_PATH = /^(?!\/)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)(?:\.{1,2}|\.git|\.pi|node_modules)(?:\/|$))[^\\\0-\x1f\x7f:%?#]+$/;
const POLICY_FIELDS = ["version", "configuredScripts", "configurationFiles", "syntaxFiles", "testFiles"];
const EXPECTED_SCRIPTS = Object.freeze({ "type-check": "node scripts/check.mjs", lint: "node scripts/check.mjs",
  test: "node --test test/*.test.js", "test:e2e": "node --test test/*.test.js" });
// Policy v1 expands this reviewed dependency-free checker into fixed --check
// invocations. Other script bodies are not equivalent merely because the npm
// script name stayed unchanged. Keep them outside this fixed policy.
const FIXED_SYNTAX_CHECKER_SHA256 = "9af8698a75a04abce876f881181d6d9688220b1d0d71f08be98919a033cacdb5";
const MAX_FILE_BYTES = 64 * 1024, MAX_FOOTPRINT_BYTES = 2 * 1024 * 1024, MAX_OUTPUT_BYTES = 256 * 1024;
const REAP_GRACE_MS = 250;
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { supervisorCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };
const plain = value => Boolean(value && typeof value === "object" && !types.isProxy(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value)));

function exact(value, names, code) {
  requireThat(plain(value), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireThat(Reflect.ownKeys(descriptors).length === names.length && names.every(name =>
    descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], "value")), code);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const validHash = value => typeof value === "string" && HASH.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;
function canonicalDirectory(value, code) {
  requireThat(typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
    && !value.includes("\0"), code);
  let real, info;
  try { real = fs.realpathSync(value); info = fs.lstatSync(real); } catch { fail(code); }
  requireThat(real === value && info.isDirectory() && !info.isSymbolicLink(), code);
  return real;
}
function outside(left, right) {
  const relative = path.relative(left, right);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
function stableFile(file, maximum, code) {
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch { fail(code); }
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n
    && before.size >= 0n && before.size <= BigInt(maximum), code);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true }),
      fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    requireThat(bytes.length === Number(before.size) && fields.every(name => before[name] === descriptor[name]
      && before[name] === after[name] && before[name] === current[name]), code);
    return Buffer.from(bytes);
  } finally { fs.closeSync(fd); }
}
function validatePaths(value, minimum, maximum, code) {
  requireThat(Array.isArray(value) && value.length >= minimum && value.length <= maximum
    && new Set(value).size === value.length && value.every(item => typeof item === "string"
      && item.length <= 1024 && SAFE_PATH.test(item))
    && value.every((item, index) => index === 0 || value[index - 1] < item), code);
  return value;
}
function validatePolicy(value) {
  if (isScopedDocsPolicy(value)) return validateScopedDocsPolicy(value, docsHelpers());
  exact(value, POLICY_FIELDS, "invalid-project-verifier-policy");
  exact(value.configuredScripts, ["type-check", "lint", "test", "test:e2e"], "invalid-project-verifier-policy");
  requireThat(value.version === SCOPED_PROJECT_VERIFIER_POLICY
    && JSON.stringify(value.configuredScripts) === JSON.stringify(EXPECTED_SCRIPTS),
  "invalid-project-verifier-policy");
  validatePaths(value.configurationFiles, 2, 8, "invalid-project-verifier-policy");
  validatePaths(value.syntaxFiles, 1, 64, "invalid-project-verifier-policy");
  validatePaths(value.testFiles, 1, 16, "invalid-project-verifier-policy");
  requireThat(JSON.stringify(value.configurationFiles) === JSON.stringify(["package.json", "scripts/check.mjs"])
    && value.syntaxFiles.every(item => item.endsWith(".js"))
    && value.testFiles.every(item => item.startsWith("test/") && item.endsWith(".test.js")
      && value.syntaxFiles.includes(item)), "invalid-project-verifier-policy");
  return deepFreeze(structuredClone(value));
}
function declaredRootFiles(root, directory, suffix) {
  const base = path.join(root, directory), result = [];
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { fail("project-footprint-unavailable"); }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(current, entry.name);
      requireThat(!entry.isSymbolicLink(), "project-footprint-node");
      if (entry.isDirectory()) walk(file);
      else {
        requireThat(entry.isFile(), "project-footprint-node");
        if (file.endsWith(suffix)) result.push(path.relative(root, file).split(path.sep).join("/"));
        else fail("project-footprint-undeclared");
      }
    }
  }
  walk(base); return result;
}
function captureFootprint(projectRoot, policy) {
  const declared = [...new Set([...policy.configurationFiles, ...policy.syntaxFiles])].sort(), actual = [
    ...declaredRootFiles(projectRoot, "src", ".js"),
    ...declaredRootFiles(projectRoot, "scripts", ".mjs"),
    ...declaredRootFiles(projectRoot, "test", ".js"), "package.json"
  ].sort();
  requireThat(JSON.stringify(actual) === JSON.stringify(declared), "project-footprint-mismatch");
  let total = 0;
  const files = declared.map(relativePath => {
    const file = path.join(projectRoot, ...relativePath.split("/"));
    requireThat(fs.realpathSync(file) === file && file.startsWith(projectRoot + path.sep), "project-footprint-path");
    const bytes = stableFile(file, MAX_FILE_BYTES, "project-footprint-drift"); total += bytes.length;
    requireThat(total <= MAX_FOOTPRINT_BYTES, "project-footprint-size");
    return { relativePath, bytes, byteLength: bytes.length, sha256: sha(bytes) };
  });
  let packageValue;
  try { packageValue = JSON.parse(files.find(item => item.relativePath === "package.json").bytes); }
  catch { fail("project-package-json"); }
  requireThat(plain(packageValue?.scripts)
    && JSON.stringify(packageValue.scripts) === JSON.stringify(policy.configuredScripts), "project-configured-scripts");
  requireThat(files.find(item => item.relativePath === "scripts/check.mjs")?.sha256 === FIXED_SYNTAX_CHECKER_SHA256,
    "project-configured-checker-unsupported");
  const identity = files.map(({ relativePath, byteLength, sha256 }) => ({ relativePath, byteLength, sha256 }));
  return { files, sourceDigest: sha(JSON.stringify({ version: 1, files: identity })) };
}
function stableNodeIdentity(nodeCommand) {
  requireThat(typeof nodeCommand === "string" && path.isAbsolute(nodeCommand) && path.normalize(nodeCommand) === nodeCommand
    && fs.realpathSync(nodeCommand) === nodeCommand, "invalid-project-verifier-node");
  const nodeSha256 = sha(stableFile(nodeCommand, 1024 * 1024 * 1024, "project-verifier-node-drift"));
  return { nodeSha256, environmentDigest: sha(JSON.stringify({ version: 1, nodeSha256 })) };
}

function docsHelpers() { return { exact, validatePaths, validatePolicy, deepFreeze, stableFile, captureFootprint, scopedProjectVerifierDigest }; }
export function scopedProjectVerifierDigest() {
  return sha(JSON.stringify([import.meta.url, new URL("./benchmark-scoped-docs-verifier.mjs", import.meta.url).href,
    new URL("./benchmark-scoped-project-verification-receipt.mjs", import.meta.url).href]
    .map(url => ({ name: path.basename(fileURLToPath(url)), sha256: sha(stableFile(fileURLToPath(url),
      1024 * 1024, "project-verifier-source-drift")) }))));
}

export function scopedProjectVerificationPlanBinding({ projectRoot, nodeCommand, policy, timeoutMs } = {}) {
  const root = canonicalDirectory(projectRoot, "invalid-project-verifier-root"), approved = validatePolicy(policy);
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs >= 25 && timeoutMs <= 30000,
    "invalid-project-verifier-plan");
  if (isScopedDocsPolicy(approved)) return scopedDocsPlanBinding({ projectRoot: root, nodeCommand, policy: approved,
    timeoutMs, protocol: SCOPED_PROJECT_VERIFICATION_PROTOCOL, verifierDigest: scopedProjectVerifierDigest() }, docsHelpers());
  const footprint = captureFootprint(root, approved), node = stableNodeIdentity(nodeCommand),
    requestDigest = sha(JSON.stringify(approved)), verifierDigest = scopedProjectVerifierDigest();
  const planDigest = sha(JSON.stringify({ version: 1, protocol: SCOPED_PROJECT_VERIFICATION_PROTOCOL,
    requestDigest, sourceDigest: footprint.sourceDigest, environmentDigest: node.environmentDigest,
    verifierDigest, timeoutMs }));
  const capabilityDigest = sha(JSON.stringify({ version: 2, protocol: SCOPED_PROJECT_VERIFICATION_PROTOCOL,
    planDigest, requestDigest, sourceDigest: footprint.sourceDigest, environmentDigest: node.environmentDigest,
    verifierDigest, timeoutMs }));
  return deepFreeze({ protocol: SCOPED_PROJECT_VERIFICATION_PROTOCOL, planDigest, requestDigest,
    sourceDigest: footprint.sourceDigest, environmentDigest: node.environmentDigest, verifierDigest, timeoutMs,
    capabilityDigest });
}

function killProcess(child, signal) {
  if (!child?.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch {}
}
function runNode(nodeCommand, args, cwd, signal) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(nodeCommand, args, { cwd, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], env: { LANG: "C", LC_ALL: "C", TZ: "UTC", NODE_NO_WARNINGS: "1" } }); }
    catch { resolve({ status: "error", reason: "process-spawn-failed" }); return; }
    let outputBytes = 0, overflow = false, spawnFailed = false;
    const chunks = [], onData = chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { overflow = true; killProcess(child, "SIGKILL"); return; }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    let aborted = signal.aborted, reapTimer;
    const abort = () => { aborted = true; killProcess(child, "SIGTERM");
      reapTimer = setTimeout(() => killProcess(child, "SIGKILL"), REAP_GRACE_MS); };
    signal.addEventListener("abort", abort, { once: true }); if (aborted) abort();
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code, childSignal) => {
      clearTimeout(reapTimer); signal.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks);
      resolve(aborted ? { status: "cancelled", reason: "project-verifier-cancelled" }
        : spawnFailed ? { status: "error", reason: "process-spawn-failed" }
        : overflow ? { status: "error", reason: "project-verifier-output-limit" }
        : { status: "completed", code, signal: childSignal, outputSha256: sha(output), outputBytes: output.length });
    });
  });
}
async function runGroup(id, invocations, nodeCommand, stage, signal) {
  const results = []; let outputBytes = 0;
  for (const args of invocations) {
    const result = await runNode(nodeCommand, args, stage, signal);
    if (result.status !== "completed") return result;
    results.push(result); outputBytes += result.outputBytes;
    if (outputBytes > MAX_OUTPUT_BYTES) return { status: "error", reason: "project-verifier-output-limit" };
  }
  const passed = results.every(item => item.code === 0 && item.signal === null);
  return { status: "completed", summary: { id, invocationCount: results.length,
    outcome: passed ? "passed" : "failed", outputSha256: sha(JSON.stringify(results)),
    outputBytes } };
}
function materializeStage(stage, footprint) {
  for (const item of footprint.files) {
    const file = path.join(stage, ...item.relativePath.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o400);
    try { fs.writeFileSync(fd, item.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
async function runPinnedProjectVerification(input) {
  if (isScopedDocsPolicy(input.policy)) return runScopedDocsVerification(input, docsHelpers());
  let stage = null, cleanupConfirmed = true, result;
  try {
    const footprint = captureFootprint(input.projectRoot, input.policy), node = stableNodeIdentity(input.nodeCommand);
    requireThat(footprint.sourceDigest === input.sourceDigest && node.environmentDigest === input.environmentDigest
      && scopedProjectVerifierDigest() === input.verifierDigest, "project-verifier-binding-drift");
    if (input.signal.aborted) return { runId: input.executionRunId, requestDigest: input.requestDigest,
      sourceDigest: input.sourceDigest, environmentDigest: input.environmentDigest, planDigest: input.planDigest,
      status: "cancelled", reason: "cancelled-before-execute", cleanupConfirmed: true };
    stage = fs.mkdtempSync(path.join(input.stagingRoot, "project-verifier-")); fs.chmodSync(stage, 0o700);
    materializeStage(stage, footprint);
    requireThat(captureFootprint(stage, input.policy).sourceDigest === input.sourceDigest,
      "project-verifier-stage-drift");
    requireThat(captureFootprint(input.projectRoot, input.policy).sourceDigest === input.sourceDigest,
      "project-verifier-binding-drift");
    const syntax = input.policy.syntaxFiles.map(file => ["--check", file]);
    const tests = [["--test", ...input.policy.testFiles]];
    const commands = [];
    for (const [id, invocations] of [["type-check", syntax], ["lint", syntax], ["test", tests], ["test:e2e", tests]]) {
      requireThat(captureFootprint(stage, input.policy).sourceDigest === input.sourceDigest,
        "project-verifier-stage-drift");
      const group = await runGroup(id, invocations, input.nodeCommand, stage, input.signal);
      if (group.status !== "completed") { result = { status: group.status, reason: group.reason }; break; }
      commands.push(group.summary);
      requireThat(captureFootprint(stage, input.policy).sourceDigest === input.sourceDigest,
        "project-verifier-stage-drift");
    }
    if (!result) {
      requireThat(captureFootprint(input.projectRoot, input.policy).sourceDigest === input.sourceDigest,
        "project-verifier-binding-drift");
      result = { status: "completed", observation: { schemaVersion: 1,
        workerVersion: SCOPED_PROJECT_VERIFIER_WORKER, verificationRunId: input.executionRunId,
        requestDigest: input.requestDigest, sourceDigest: input.sourceDigest, commandSetDigest: input.planDigest,
        outcome: commands.every(item => item.outcome === "passed") ? "passed" : "failed", commands } };
    }
  } catch (error) {
    result = { status: "error", reason: typeof error?.supervisorCode === "string"
      ? error.supervisorCode : "project-verifier-error" };
  } finally {
    if (stage) {
      try { fs.rmSync(stage, { recursive: true, force: false }); cleanupConfirmed = !fs.existsSync(stage); }
      catch { cleanupConfirmed = false; }
    }
  }
  const common = { runId: input.executionRunId, requestDigest: input.requestDigest, sourceDigest: input.sourceDigest,
    environmentDigest: input.environmentDigest, planDigest: input.planDigest, status: result.status, cleanupConfirmed };
  return result.status === "completed" ? { ...common, observation: result.observation }
    : { ...common, reason: result.reason };
}

function normalizeExecution(execution, state) {
  const docs = isScopedDocsPolicy(state.policy), worker = docs ? SCOPED_DOCS_WORKER : SCOPED_PROJECT_VERIFIER_WORKER,
    ids = docs ? DOCS_COMMAND_IDS : ["type-check", "lint", "test", "test:e2e"];
  try {
    requireThat(plain(execution) && execution.runId === state.attemptId
      && execution.requestDigest === state.requestDigest && execution.sourceDigest === state.sourceDigest
      && execution.environmentDigest === state.environmentDigest && execution.planDigest === state.planDigest
      && ["completed", "timeout", "cancelled", "error"].includes(execution.status)
      && typeof execution.cleanupConfirmed === "boolean", "project-execution-binding-invalid");
    let observation = null;
    if (execution.status === "completed") {
      exact(execution, ["runId", "requestDigest", "sourceDigest", "environmentDigest", "planDigest", "status",
        "cleanupConfirmed", "observation"], "project-execution-binding-invalid");
      observation = execution.observation;
      exact(observation, ["schemaVersion", "workerVersion", "verificationRunId", "requestDigest", "sourceDigest",
        "commandSetDigest", "outcome", "commands"], "project-execution-binding-invalid");
      requireThat(observation.schemaVersion === 1 && observation.workerVersion === worker
        && observation.verificationRunId === state.attemptId && observation.requestDigest === state.requestDigest
        && observation.sourceDigest === state.sourceDigest && observation.commandSetDigest === state.planDigest
        && ["passed", "failed"].includes(observation.outcome) && Array.isArray(observation.commands)
        && observation.commands.length === ids.length, "project-execution-binding-invalid");
      for (const [index, command] of observation.commands.entries()) {
        exact(command, ["id", "invocationCount", "outcome", "outputSha256", "outputBytes"],
          "project-execution-binding-invalid");
        requireThat(command.id === ids[index] && Number.isSafeInteger(command.invocationCount)
          && command.invocationCount >= 1 && command.invocationCount <= 64 && ["passed", "failed"].includes(command.outcome)
          && validHash(command.outputSha256) && Number.isSafeInteger(command.outputBytes)
          && command.outputBytes >= 0 && command.outputBytes <= MAX_OUTPUT_BYTES
          && (observation.outcome === "passed") === observation.commands.every(item => item.outcome === "passed"),
        "project-execution-binding-invalid");
      }
    } else {
      exact(execution, ["runId", "requestDigest", "sourceDigest", "environmentDigest", "planDigest", "status",
        "cleanupConfirmed", "reason"], "project-execution-binding-invalid");
      requireThat(typeof execution.reason === "string" && /^[a-z0-9-]{1,80}$/.test(execution.reason),
        "project-execution-binding-invalid");
    }
    return { observation, executionSha256: sha(JSON.stringify(execution)),
      observationSha256: observation ? sha(JSON.stringify(observation)) : null, status: execution.status,
      reason: execution.reason ?? null, cleanupConfirmed: execution.cleanupConfirmed, integrityFailure: false };
  } catch {
    return { observation: null, executionSha256: sha("invalid-project-execution-result"), observationSha256: null,
      status: "error", reason: "project-execution-binding-invalid", cleanupConfirmed: false, integrityFailure: true };
  }
}

export function validateScopedProjectVerificationReceipt(receipt) {
  return validateProjectReceipt(receipt, { exact, plain, requireThat, validHash, validTime, validatePaths,
    HASH, ID, UUID_V4, SCOPED_PROJECT_VERIFICATION_PROTOCOL, SCOPED_PROJECT_VERIFICATION_RECEIPT, SCOPED_PROJECT_VERIFIER_WORKER });
}

export function createScopedProjectVerificationSupervisor({ manifestSha256, brokerIdentitySha256,
  brokerSourceSha256, receiptPrivateKey, verifications, execute = runPinnedProjectVerification,
  clock = Date.now, createAttemptId = randomUUID } = {}) {
  requireThat([manifestSha256, brokerIdentitySha256, brokerSourceSha256].every(validHash)
    && Array.isArray(verifications) && verifications.length > 0 && verifications.length <= 32
    && typeof execute === "function" && typeof clock === "function" && typeof createAttemptId === "function",
  "invalid-supervisor-configuration");
  const privateKey = receiptPrivateKey?.type === "private" ? receiptPrivateKey : createPrivateKey(receiptPrivateKey);
  requireThat(privateKey.asymmetricKeyType === "ed25519", "invalid-receipt-key");
  const receiptPublicKey = createPublicKey(privateKey), receiptPublicKeyPem = receiptPublicKey.export({ type: "spki", format: "pem" }),
    receiptKeyDigest = sha(receiptPublicKey.export({ type: "spki", format: "der" })), plans = new Map();
  for (const item of verifications) {
    exact(item, ["manifest", "plan"], "invalid-supervisor-configuration");
    exact(item.manifest, ["id", "protocol", "capabilityDigest", "receiptKeyDigest", "timeoutMs"],
      "invalid-supervisor-configuration");
    exact(item.plan, ["projectRoot", "nodeCommand", "stagingRoot", "policy", "expectedPlanDigest"],
      "invalid-supervisor-configuration");
    const entry = item.manifest, projectRoot = canonicalDirectory(item.plan.projectRoot, "invalid-project-verifier-root"),
      stagingRoot = canonicalDirectory(item.plan.stagingRoot, "invalid-project-verifier-stage"),
      binding = scopedProjectVerificationPlanBinding({ projectRoot, nodeCommand: item.plan.nodeCommand,
        policy: item.plan.policy, timeoutMs: entry.timeoutMs });
    requireThat(typeof entry.id === "string" && ID.test(entry.id) && !plans.has(entry.id)
      && entry.protocol === SCOPED_PROJECT_VERIFICATION_PROTOCOL && entry.capabilityDigest === binding.capabilityDigest
      && entry.receiptKeyDigest === receiptKeyDigest && item.plan.expectedPlanDigest === binding.planDigest
      && outside(projectRoot, stagingRoot) && outside(stagingRoot, projectRoot), "invalid-supervisor-configuration");
    plans.set(entry.id, deepFreeze({ ...binding, id: entry.id, projectRoot, nodeCommand: item.plan.nodeCommand,
      stagingRoot, policy: validatePolicy(item.plan.policy) }));
  }
  let active = null; const completed = new Map();
  function stateFor(attemptId) {
    requireThat(UUID_V4.test(attemptId) && active?.attemptId === attemptId, "verification-attempt-unavailable");
    return active;
  }
  function envelope(state, normalized, settledAtMs) {
    const docs = isScopedDocsPolicy(state.policy);
    const receipt = { version: docs ? 3 : 2, kind: docs ? SCOPED_DOCS_RECEIPT : SCOPED_PROJECT_VERIFICATION_RECEIPT,
      protocol: SCOPED_PROJECT_VERIFICATION_PROTOCOL, verificationId: state.verificationId, action: state.action,
      attemptId: state.attemptId, broker: { identitySha256: brokerIdentitySha256, sourceSha256: brokerSourceSha256 },
      manifestSha256, capabilityDigest: state.capabilityDigest, planDigest: state.planDigest,
      requestDigest: state.requestDigest, sourceDigest: state.sourceDigest, environmentDigest: state.environmentDigest,
      verifierDigest: state.verifierDigest, worker: { runId: state.attemptId,
        version: normalized.observation?.workerVersion ?? null }, status: normalized.status,
      verdict: normalized.status === "completed" && normalized.cleanupConfirmed && normalized.observation
        ? "observation-recorded" : "observation-unavailable", cleanup: { confirmed: normalized.cleanupConfirmed },
      evidence: { executionSha256: normalized.executionSha256,
        observationSha256: normalized.observationSha256, reason: normalized.reason,
        outcome: normalized.observation?.outcome ?? null,
        failedCommands: normalized.observation?.commands.filter(item => item.outcome === "failed").map(item => item.id) ?? [] },
      startedAtMs: state.startedAtMs,
      deadlineAtMs: state.deadlineAtMs, settledAtMs, completionAllowed: false, ...(docs ? { scope: state.docsScope } : {}) };
    validateScopedProjectVerificationReceipt(receipt);
    return deepFreeze({ receipt, signature: sign(null, Buffer.from(JSON.stringify(receipt)), privateKey).toString("base64") });
  }
  async function settle(state) {
    if (state.promise) return state.promise;
    state.promise = (async () => {
      let execution;
      try {
        const invocation = state.controller.signal.aborted ? Promise.resolve({ runId: state.attemptId,
          requestDigest: state.requestDigest, sourceDigest: state.sourceDigest,
          environmentDigest: state.environmentDigest, planDigest: state.planDigest, status: "cancelled",
          reason: "cancelled-before-execute", cleanupConfirmed: true }) : Promise.resolve(execute({ ...state,
          signal: state.controller.signal, executionRunId: state.attemptId }));
        invocation.catch(() => undefined); execution = await Promise.race([invocation, state.deadlineGate]);
      } catch {
        execution = { runId: state.attemptId, requestDigest: state.requestDigest, sourceDigest: state.sourceDigest,
          environmentDigest: state.environmentDigest, planDigest: state.planDigest, status: "error",
          reason: "executor-threw", cleanupConfirmed: false };
      }
      const normalized = normalizeExecution(execution, state), settledAtMs = clock();
      requireThat(validTime(settledAtMs) && settledAtMs >= state.startedAtMs, "invalid-supervisor-clock");
      if (state.deadlineExpired || settledAtMs >= state.deadlineAtMs) {
        normalized.observation = null; normalized.observationSha256 = null;
        normalized.status = "timeout"; normalized.reason = "supervisor-deadline";
      } else if (state.cancelRequested) {
        normalized.observation = null; normalized.observationSha256 = null;
        normalized.status = "cancelled"; normalized.reason = "supervisor-cancelled";
      }
      const result = deepFreeze({ envelope: envelope(state, normalized, settledAtMs),
        observation: normalized.observation, integrityFailure: normalized.integrityFailure });
      completed.set(state.attemptId, result); if (completed.size > 32) completed.delete(completed.keys().next().value);
      return result;
    })().finally(() => { clearTimeout(state.deadlineTimer); clearTimeout(state.reapTimer);
      if (active === state) active = null; });
    return state.promise;
  }
  const bridge = { version: "scoped-verification-supervisor-v1", receiptPublicKey: receiptPublicKeyPem,
    receiptKeyDigest,
    begin(request) {
      exact(request, ["verificationId", "action", "brokerIdentitySha256", "brokerSourceSha256", "manifestSha256",
        "capabilityDigest"], "invalid-verification-request");
      requireThat(!active && typeof request.verificationId === "string" && ID.test(request.verificationId)
        && Number.isSafeInteger(request.action) && request.action > 0
        && request.brokerIdentitySha256 === brokerIdentitySha256 && request.brokerSourceSha256 === brokerSourceSha256
        && request.manifestSha256 === manifestSha256, "verification-inflight-or-binding-invalid");
      const plan = plans.get(request.verificationId);
      requireThat(plan && request.capabilityDigest === plan.capabilityDigest, "verification-denied");
      const startedAtMs = clock(), attemptId = createAttemptId();
      requireThat(validTime(startedAtMs) && Number.isSafeInteger(startedAtMs + plan.timeoutMs)
        && UUID_V4.test(attemptId), "invalid-supervisor-runtime");
      let expire; const deadlineGate = new Promise(resolve => { expire = resolve; });
      const current = isScopedDocsPolicy(plan.policy) ? prepareScopedDocsAttempt(plan, docsHelpers()) : {};
      const state = { ...plan, ...current, verificationId: request.verificationId, action: request.action, attemptId,
        startedAtMs, deadlineAtMs: startedAtMs + plan.timeoutMs, controller: new AbortController(), promise: null,
        cancelRequested: false, deadlineExpired: false, deadlineTimer: null, reapTimer: null, deadlineGate };
      active = state; state.deadlineTimer = setTimeout(() => {
        state.deadlineExpired = true; state.controller.abort(); state.reapTimer = setTimeout(() => expire({
          runId: state.attemptId, requestDigest: state.requestDigest, sourceDigest: state.sourceDigest,
          environmentDigest: state.environmentDigest, planDigest: state.planDigest, status: "timeout",
          reason: "executor-reap-unconfirmed", cleanupConfirmed: false }), REAP_GRACE_MS);
        void settle(state).catch(() => undefined);
      }, plan.timeoutMs);
      return deepFreeze({ attemptId, verificationId: state.verificationId, capabilityDigest: state.capabilityDigest,
        planDigest: state.planDigest, requestDigest: state.requestDigest, sourceDigest: state.sourceDigest,
        environmentDigest: state.environmentDigest, verifierDigest: state.verifierDigest,
        startedAtMs, deadlineAtMs: state.deadlineAtMs });
    },
    execute(attemptId) { return completed.has(attemptId) ? Promise.resolve(completed.get(attemptId))
      : settle(stateFor(attemptId)); },
    cancel(attemptId) { if (!UUID_V4.test(attemptId) || active?.attemptId !== attemptId) return false;
      if (!active.deadlineExpired) active.cancelRequested = true; active.controller.abort(); return true; },
    reconcile(attemptId) { return completed.has(attemptId) ? Promise.resolve(completed.get(attemptId))
      : settle(stateFor(attemptId)); },
    status() { return deepFreeze({ active: active ? { attemptId: active.attemptId,
      verificationId: active.verificationId, action: active.action, capabilityDigest: active.capabilityDigest,
      planDigest: active.planDigest, requestDigest: active.requestDigest, sourceDigest: active.sourceDigest,
      environmentDigest: active.environmentDigest, verifierDigest: active.verifierDigest,
      startedAtMs: active.startedAtMs, deadlineAtMs: active.deadlineAtMs } : null, completed: completed.size }); }
  };
  return deepFreeze(bridge);
}
