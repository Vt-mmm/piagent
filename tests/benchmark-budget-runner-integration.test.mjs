import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const runner = path.join(sourceRoot, "scripts", "benchmark-runner.mjs");
const executionKeys = ["model", "thinking", "serviceTier", "surfaces", "repeats", "timeoutSeconds",
  "infrastructureRetries", "codexMode", "codexBaseline", "piagentTreatment"];

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-runner-integration-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const suiteRoot = path.join(dir, "suite"), project = path.join(suiteRoot, "project");
  const operatorHome = path.join(dir, "fake-operator-home"), fakePi = path.join(dir, "fake-pi.mjs");
  const fakeTrace = path.join(dir, "fake-invocations.jsonl");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(operatorHome, { mode: 0o700 });
  fs.writeFileSync(path.join(operatorHome, "auth.json"), JSON.stringify({ test: { type: "api_key", key: "FAKE_TEST_ONLY" } }), { mode: 0o600 });
  fs.writeFileSync(path.join(operatorHome, "settings.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "budget-integration-fixture", private: true, type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(project, ".gitignore"), ".pi/piagent-state/\n");
  fs.writeFileSync(path.join(project, "result.txt"), "wrong\n");
  fs.writeFileSync(path.join(suiteRoot, "prompt.md"), "Write correct to result.txt.\n");
  fs.writeFileSync(path.join(suiteRoot, "grade.mjs"), [
    'import fs from "node:fs";', 'import path from "node:path";',
    'const passed = fs.readFileSync(path.join(process.argv[2], "result.txt"), "utf8") === "correct\\n";',
    'console.log(JSON.stringify({ passed, checks: [{ id: "result", passed }] }));', ""
  ].join("\n"));
  const suite = path.join(suiteRoot, "suite.json");
  fs.writeFileSync(suite, JSON.stringify({ schemaVersion: 1, id: "budget-integration-v1", title: "Offline budget integration",
    profile: "node-typescript", defaultRepeats: 2, timeoutSeconds: 30,
    scenarios: [{ id: "write-result", title: "Write result", kind: "source-change", fixture: "project",
      prompt: "prompt.md", grader: "grade.mjs", allowedChanges: ["result.txt"] }] }));
  // This executable has no SDK or networking: all provider-shaped evidence is authored locally.
  fs.writeFileSync(fakePi, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const mark = (phase, details = {}) => fs.appendFileSync(process.env.BENCHMARK_FAKE_BUDGET_TRACE,
  JSON.stringify({ phase, timestampMs: Date.now(), pid: process.pid, ...details }) + "\\n");
mark("entry", { invocation: process.argv.includes("--version") ? "version" : "provider" });
if (process.argv.includes("--version")) { mark("version-return"); console.log("0.82.0-test-budget"); process.exit(0); }
const value = name => process.argv[process.argv.indexOf(name) + 1];
const surface = process.env.PIAGENT_BENCHMARK_SURFACE;
const sessionId = value("--session-id"), sessionDir = value("--session-dir");
const extension = process.argv.includes("--extension") ? value("--extension") : null;
const extensionInSnapshot = extension?.includes("/piagent-benchmark-snapshot-") === true;
const extensionExists = extension !== null && fs.existsSync(extension);
const budgetContextPresent = Boolean(process.env.PIAGENT_BENCHMARK_BUDGET_CONTEXT);
mark("provider-guards", { surface, extensionInSnapshot, extensionExists, budgetContextPresent });
if (surface === "piagent" && (!extensionInSnapshot || !extensionExists)) { mark("guard-exit", { code: 41 }); process.exit(41); }
if (budgetContextPresent) { mark("guard-exit", { code: 42 }); process.exit(42); }
fs.appendFileSync(process.env.BENCHMARK_FAKE_BUDGET_ATTEMPTS, JSON.stringify({ surface, sessionId, extension, pid: process.pid }) + "\\n");
mark("attempt-recorded", { surface });
if (process.env.BENCHMARK_FAKE_BUDGET_UNKNOWN === "1") { mark("unknown-exit", { code: 1 }); process.exit(1); }
fs.writeFileSync(path.join(process.cwd(), "result.txt"), "correct\\n");
const timestamp = new Date().toISOString(), input = surface === "piagent" ? 50 : 100;
const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
const entries = [
  { type: "session", id: sessionId, cwd: process.cwd(), timestamp },
  { type: "model_change", provider: "test", modelId: "fake-model", timestamp },
  { type: "thinking_level_change", thinkingLevel: "high", timestamp },
  { type: "message", timestamp, message: { ...assistant, usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + 10 } } }
];
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, "session.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\\n") + "\\n");
const user = { role: "user", content: "Write correct to result.txt." };
const events = [
  { type: "session", version: 3, id: sessionId, timestamp, cwd: process.cwd() },
  { type: "agent_start" }, { type: "turn_start" },
  { type: "message_start", message: user }, { type: "message_end", message: user },
  { type: "message_start", message: { role: "assistant", content: [] } },
  { type: "message_end", message: assistant },
  { type: "turn_end", message: assistant, toolResults: [] },
  { type: "agent_end", messages: [user, assistant], willRetry: false }, { type: "agent_settled" }
];
for (const event of events) console.log(JSON.stringify(event));
`, { mode: 0o700 });
  const output = path.join(dir, "run"), state = path.join(dir, "budget-state.json"), policy = path.join(dir, "policy.json");
  const attempts = path.join(dir, "fake-attempts.jsonl");
  const args = ["--suite", suite, "--surfaces", "raw-pi,piagent", "--model", "test/fake-model", "--thinking", "high",
    "--service-tier", "default", "--seed", "offline-budget-fixed-seed", "--repeats", "2", "--timeout", "30",
    "--infrastructure-retries", "0", "--output", output];
  const env = { ...process.env, PI_CODING_AGENT_DIR: operatorHome, PIAGENT_BENCHMARK_PI_COMMAND: fakePi,
    BENCHMARK_FAKE_BUDGET_ATTEMPTS: attempts, BENCHMARK_FAKE_BUDGET_TRACE: fakeTrace };
  // Keep operator-specific benchmark controls and real credentials out of the fake subprocesses.
  for (const key of Object.keys(env)) if ((key.startsWith("PIAGENT_") && key !== "PIAGENT_BENCHMARK_PI_COMMAND")
    || /^(OPENAI_API_KEY|CODEX_ACCESS_TOKEN|ANTHROPIC_API_KEY|BENCHMARK_FAKE_BUDGET_UNKNOWN|BENCHMARK_BUDGET_DIAGNOSTIC_REPRO)$/.test(key)) delete env[key];
  return { dir, suite, output, state, policy, attempts, fakeTrace, args, env };
}

function invoke(value, args, env = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [...(value.diagnosticPreload ? ["--import", value.diagnosticPreload] : []), runner, ...args], { cwd: sourceRoot, encoding: "utf8",
    timeout: 90_000, maxBuffer: 4 * 1024 * 1024, env: { ...value.env, ...env } });
  if (value.retainDiagnostics) value.retainDiagnostics(invocationDiagnostic(value, args, result, performance.now() - started));
  return result;
}
function invocationDiagnostic(value, args, result, elapsedMs) {
  const redact = text => String(text ?? "").replaceAll(value.dir, "<fixture>").replaceAll(sourceRoot, "<source>")
    .replaceAll("FAKE_TEST_ONLY", "<fake-credential>")
    .replace(/\/(?:Users|private\/var\/folders|var\/folders|private\/tmp|tmp)\/[^\s"'<>]+/g, "<local-path>");
  const output = text => ({ bytes: Buffer.byteLength(text ?? ""),
    sha256: createHash("sha256").update(text ?? "").digest("hex"), tail: redact(text).slice(-6000) });
  const read = (file, jsonl = false) => {
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > 512 * 1024) return { diagnosticError: "file-exceeds-diagnostic-bound" };
    try { const text = fs.readFileSync(file, "utf8"); return jsonl
      ? text.trim().split("\n").filter(Boolean).slice(-32).map(line => JSON.parse(line)) : JSON.parse(text); }
    catch (error) { return { diagnosticError: error.code ?? error.name }; }
  };
  const saved = read(value.state), state = saved?.state;
  const manifest = read(path.join(value.output, "run-manifest.json"));
  const fakeInvocations = read(value.fakeTrace, true);
  const recordedAttempts = read(value.attempts, true);
  const infrastructure = read(path.join(value.output, "infrastructure-attempts.jsonl"), true);
  const aborted = read(path.join(value.output, "aborted.json"));
  return { kind: "offline-budget-invocation-diagnostic-v1", fixtureOnly: true,
    reproduction: value.reproduction ?? null,
    invocation: args.includes("--preflight-only") ? "preflight" : args.includes("--resume") ? "resume" : "run",
    elapsedMs, outerTimeoutMs: 90_000, sessionTimeoutSeconds: 30, stageThresholdMs: 120_000,
    process: { status: result.status, signal: result.signal, errorCode: result.error?.code ?? null },
    stdout: output(result.stdout), stderr: output(result.stderr),
    fakeInvocations, fakeAttempts: Array.isArray(recordedAttempts)
      ? recordedAttempts.map(attempt => ({ surface: attempt.surface, pid: attempt.pid })) : recordedAttempts,
    controlledEvents: value.controlTrace ? read(value.controlTrace, true) : null,
    infrastructure: Array.isArray(infrastructure) ? infrastructure.map(record => ({
      surface: record.surface, orderIndex: record.orderIndex, failure: redact(record.infrastructureFailure ?? record.failure).slice(0, 2000),
      usageStatus: record.usageStatus, agent: record.agent && { code: record.agent.code, timedOut: record.agent.timedOut, signal: record.agent.signal }
    })) : infrastructure,
    aborted: aborted ? { reason: redact(aborted.reason).slice(0, 2000), completedRuns: aborted.completedRuns } : null,
    state: state ? { stopReasons: state.stopReasons, activeWallTimeExact: state.activeWallTimeExact,
      attempts: state.attempts.map(attempt => ({ orderIndex: attempt.orderIndex, surface: attempt.surface,
        status: attempt.status, usage: attempt.usage, usageStatus: attempt.usageStatus })),
      stages: state.stages.map(stage => ({ startedAtMs: stage.startedAtMs, lastCheckpointAtMs: stage.lastCheckpointAtMs,
        elapsedMs: stage.elapsedMs, status: stage.status, attachmentUsed: stage.attachmentUsed })) } : saved,
    manifest: manifest ? { present: true, candidateDigest: manifest.candidateProvenance?.contentDigest,
      timeoutSeconds: manifest.configuration?.timeoutSeconds } : null };
}

function delayedOwnershipReceiptControl(value) {
  value.controlTrace = path.join(value.dir, "controlled-ownership.jsonl");
  value.diagnosticPreload = path.join(value.dir, "delay-owned-ack.mjs");
  value.reproduction = "delay-first-ownership-ack-6000ms";
  // Test-only preload of the outer wrapper. No product deadline is changed.
  // Delay one actual IPC receipt without generating CPU load or dispatching a provider.
  fs.writeFileSync(value.diagnosticPreload, `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const trace = ${JSON.stringify(value.controlTrace)};
const mark = (phase, details = {}) => fs.appendFileSync(trace, JSON.stringify({ phase, timestampMs: Date.now(), ...details }) + '\\n');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (!args.some(arg => String(arg).endsWith('/benchmark-runner-core.mjs')) || !options?.stdio?.includes('ipc')) return child;
  const send = child.send.bind(child); let delayed = false;
  child.send = function(message, ...rest) {
    if (!delayed && message?.kind === 'benchmark-budget-process-ack-v1' && message.event === 'started') {
      delayed = true; mark('ownership-ack-held', { pid: message.pid, delayMs: 6000 });
      setTimeout(() => {
        mark(child.connected ? 'ownership-ack-released' : 'ownership-channel-already-closed', { pid: message.pid });
        if (child.connected) send(message, ...rest);
      }, 6000);
      return true;
    }
    return send(message, ...rest);
  };
  return child;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
}
function diagnostic(result) { return `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`; }
function success(result) { assert.equal(result.status, 0, diagnostic(result)); return result; }
function accounting(result) {
  const line = result.stdout.split("\n").find(value => value.startsWith("Budget stage accounting: "));
  assert.ok(line, diagnostic(result));
  return JSON.parse(line.slice("Budget stage accounting: ".length));
}
function readState(value) { return JSON.parse(fs.readFileSync(value.state, "utf8")).state; }
function attempts(value) {
  return fs.existsSync(value.attempts) ? fs.readFileSync(value.attempts, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}
function budgetArgs(value) { return ["--budget-policy", value.policy, "--budget-state", value.state]; }
function bindPolicy(value, overrides = {}) {
  const receipt = JSON.parse(success(invoke(value, [...value.args, "--preflight-only", "--json"])).stdout);
  assert.equal(receipt.providerSessionsStarted, 0);
  assert.deepEqual(attempts(value), []);
  const plannedAttempts = [
    { orderIndex: 1, scenarioId: "write-result", surface: "piagent", repeat: 1 },
    { orderIndex: 2, scenarioId: "write-result", surface: "raw-pi", repeat: 1 },
    { orderIndex: 3, scenarioId: "write-result", surface: "raw-pi", repeat: 2 },
    { orderIndex: 4, scenarioId: "write-result", surface: "piagent", repeat: 2 }
  ];
  const policy = { schemaVersion: 1, kind: "benchmark-management-budget-v1", authorityDecision: "OFFLINE_TEST_ONLY",
    policy: { semantics: "management-thresholds", maxProviderAttempts: 4, freshTokenThreshold: 10_000,
      activeWallTimeMsThreshold: 120_000, ...overrides },
    binding: { runRoot: value.output, candidateDigest: receipt.candidateProvenance.contentDigest,
      suiteDigest: receipt.suite.contentDigest,
      execution: Object.fromEntries(executionKeys.map(key => [key, receipt.configuration[key]])), plannedAttempts } };
  fs.writeFileSync(value.policy, JSON.stringify(policy), { mode: 0o600 });
  return policy;
}

test("real wrapper keeps provider-free checks free and accumulates fake paid stages without resetting the cap", { timeout: 240_000 }, t => {
  const value = fixture(t), policy = bindPolicy(value), bound = [...value.args, ...budgetArgs(value)];
  success(invoke(value, [...bound, "--dry-run"]));
  const ready = JSON.parse(success(invoke(value, [...bound, "--preflight-only", "--json"])).stdout);
  assert.equal(ready.providerSessionsStarted, 0);
  assert.equal(fs.existsSync(value.state), false);
  assert.equal(fs.existsSync(`${value.state}.guard`), false);
  assert.deepEqual(attempts(value), []);

  success(invoke(value, [...bound, "--max-sessions", "2", "--yes"]));
  const first = readState(value), manifest = JSON.parse(fs.readFileSync(path.join(value.output, "run-manifest.json"), "utf8"));
  assert.equal(first.attempts.length, 2);
  assert.ok(first.attempts.every(attempt => attempt.status === "exact"));
  assert.equal(first.stages.length, 1);
  assert.equal(first.stages[0].status, "closed");
  assert.equal(first.stages.some(stage => stage.status === "active"), false);
  assert.equal(manifest.candidateProvenance.contentDigest, policy.binding.candidateDigest);
  assert.equal(manifest.budgetControl.statePath, value.state);
  assert.equal(attempts(value).length, 2);

  const beforeDrift = fs.readFileSync(value.state), changedModel = [...bound];
  changedModel[changedModel.indexOf("--model") + 1] = "test/other-model";
  const drift = invoke(value, [...changedModel, "--dry-run"]);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /execution configuration differs/);
  assert.deepEqual(fs.readFileSync(value.state), beforeDrift);
  assert.equal(attempts(value).length, 2);

  // Resume restores the exact policy identity from the run manifest without repeated CLI flags.
  const resumed = invoke(value, ["--resume", value.output, "--max-sessions", "2", "--yes"]);
  // The fake executable deliberately supplies no Pi task evidence: accounting must
  // finish truthfully without promoting this integration fixture to a quality pass.
  assert.equal(resumed.status, 1, diagnostic(resumed));
  assert.match(resumed.stdout, /Verdict: workflow-gate-failed/);
  assert.equal(accounting(resumed).launcherSucceeded, true);
  assert.equal(accounting(resumed).processCleanup.cleanupConfirmed, true);
  const final = readState(value), report = JSON.parse(fs.readFileSync(path.join(value.output, "report.json"), "utf8"));
  assert.equal(final.attempts.length, 4);
  assert.ok(final.attempts.every(attempt => attempt.status === "exact"));
  assert.equal(final.stages.length, 2);
  assert.ok(final.stages.every(stage => stage.status === "closed" && stage.elapsedMs > 0));
  assert.equal(final.stages.some(stage => stage.status === "active"), false);
  assert.ok(final.stopReasons.includes("session-cap"));
  assert.equal(report.runCount, 4);
  assert.equal(attempts(value).length, 4);
  assert.deepEqual(final.attempts.slice(0, 2), first.attempts);
  assert.equal(final.attempts.reduce((total, attempt) => total + attempt.usage.fresh, 0), 340);
  assert.equal(report.environment.candidateProvenance.finalization, "immutable-snapshot-rehashed-and-matched");
  const capped = invoke(value, ["--resume", value.output, "--max-sessions", "2", "--yes"]);
  assert.notEqual(capped.status, 0);
  assert.match(diagnostic(capped), /session-cap/);
  assert.equal(readState(value).attempts.length, 4);
  assert.equal(attempts(value).length, 4);
});

test("real wrapper retains an exact in-flight token overshoot and denies further fake provider dispatch", { timeout: 150_000 }, t => {
  const value = fixture(t);
  bindPolicy(value, { freshTokenThreshold: 1 });
  const result = invoke(value, [...value.args, ...budgetArgs(value), "--max-sessions", "2", "--yes"]);
  assert.notEqual(result.status, 0, diagnostic(result));
  const state = readState(value);
  assert.equal(attempts(value).length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, "exact");
  assert.equal(state.attempts[0].usage.fresh, 60);
  assert.ok(state.stopReasons.includes("fresh-token-threshold"));
  assert.equal(accounting(result).overshoot.freshTokens, 59);
  assert.equal(accounting(result).hardCapProven, false);
  assert.equal(state.stages.some(stage => stage.status === "active"), false);
  const resumed = invoke(value, ["--resume", value.output, "--max-sessions", "2", "--yes"]);
  assert.notEqual(resumed.status, 0);
  assert.equal(attempts(value).length, 1);
});

test("real wrapper preserves unknown fake provider usage and fails closed on resume", { timeout: 150_000 }, t => {
  const value = fixture(t);
  // Retain bounded invocation/state evidence before assertions and fixture cleanup.
  // This is a fake CLI trace, never native provider dispatch or paid usage proof.
  value.retainDiagnostics = evidence => t.diagnostic(JSON.stringify(evidence));
  bindPolicy(value);
  const reproduction = process.env.BENCHMARK_BUDGET_DIAGNOSTIC_REPRO;
  if (reproduction !== undefined) {
    assert.equal(reproduction, "delay-first-ownership-ack");
    delayedOwnershipReceiptControl(value);
  }
  const result = invoke(value, [...value.args, ...budgetArgs(value), "--max-sessions", "2", "--yes"], { BENCHMARK_FAKE_BUDGET_UNKNOWN: "1" });
  assert.notEqual(result.status, 0, diagnostic(result));
  const state = readState(value);
  assert.equal(attempts(value).length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, "unknown");
  assert.equal(state.attempts[0].usage, null);
  assert.ok(state.stopReasons.includes("unknown-usage"));
  assert.equal(accounting(result).freshTokens, null);
  assert.equal(accounting(result).unknownAttempts, 1);
  assert.equal(state.stages.some(stage => stage.status === "active"), false);
  const resumed = invoke(value, ["--resume", value.output, "--max-sessions", "2", "--yes"]);
  assert.notEqual(resumed.status, 0);
  assert.equal(attempts(value).length, 1);
  assert.equal(readState(value).attempts[0].status, "unknown");
});
