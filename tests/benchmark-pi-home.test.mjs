import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertBenchmarkPiHomeConfigIdentity,
  assertBenchmarkPiRuntimeMatchesSeed,
  benchmarkPiCredentialFileIdentity,
  benchmarkPiHomeConfigIdentity,
  benchmarkPiHomePublicIdentity,
  acquireBenchmarkPiCredentialWriteback,
  cleanupBenchmarkPiRuntimeHome,
  createBenchmarkPiRuntimeHome,
  recoverBenchmarkPiCredentialWriteback,
  resetBenchmarkPiRuntimeEphemeralState
} from "../packages/piagent-core/benchmark/benchmark-pi-home.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch { /* Continue. */ }
  }
  return undefined;
}

function controlledHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-pi-home-"));
  const configRoot = path.join(root, "seed");
  const operatorRoot = path.join(root, "operator");
  const runtimeParent = path.join(root, "runtime");
  t.after(() => {
    try { fs.chmodSync(configRoot, 0o700); } catch { /* Already removed. */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(configRoot, { mode: 0o700 });
  fs.mkdirSync(operatorRoot, { mode: 0o700 });
  fs.mkdirSync(runtimeParent, { mode: 0o700 });
  const auth = '{"test":{"type":"oauth","accountId":"fake-account","access":"PRIVATE_AUTH_CANARY","refresh":"initial"}}\n';
  fs.writeFileSync(path.join(configRoot, "auth.json"), auth, { mode: 0o400 });
  fs.writeFileSync(path.join(operatorRoot, "auth.json"), auth, { mode: 0o600 });
  fs.writeFileSync(path.join(configRoot, "settings.json"), '{"theme":"dark"}\n', { mode: 0o400 });
  fs.writeFileSync(path.join(configRoot, "models.json"), '{"models":[]}\n', { mode: 0o400 });
  fs.chmodSync(configRoot, 0o500);
  return {
    root,
    piAgentHome: {
      configRoot,
      runtimeParent,
      seedIdentity: benchmarkPiHomeConfigIdentity(configRoot, { requiredFileMode: "400" }),
      requestedProvider: "test",
      writebackAuthorized: true,
      operatorAuth: {
        path: path.join(operatorRoot, "auth.json"),
        identity: benchmarkPiCredentialFileIdentity(path.join(operatorRoot, "auth.json"))
      }
    }
  };
}

test("Pi runtime is writable, preserves only credential rotation, and resets ephemeral state", (t) => {
  const { piAgentHome } = controlledHome(t);
  const runtime = createBenchmarkPiRuntimeHome(piAgentHome);
  assert.equal(fs.statSync(runtime.path).mode & 0o777, 0o700);
  for (const name of ["auth.json", "models.json", "settings.json"]) assert.equal(fs.statSync(path.join(runtime.path, name)).mode & 0o777, 0o600);
  fs.mkdirSync(path.join(runtime.path, "settings.json.lock"));
  fs.writeFileSync(path.join(runtime.path, "models-store.json"), "{}\n");
  let lockError;
  assert.throws(() => benchmarkPiHomeConfigIdentity(runtime.path, { requiredFileMode: "600" }), (error) => {
    lockError = error;
    return /unreleased lock/.test(error.message);
  });
  assert.deepEqual(lockError.piHomeMismatch, { classification: "unreleased-lock", entry: "settings.json.lock" });
  fs.rmSync(path.join(runtime.path, "settings.json.lock"), { recursive: true });
  const rotated = JSON.parse(fs.readFileSync(path.join(runtime.path, "auth.json"), "utf8"));
  rotated.test.refresh = "rotated";
  fs.writeFileSync(path.join(runtime.path, "auth.json"), `${JSON.stringify(rotated)}\n`, { mode: 0o600 });
  assert.doesNotThrow(() => assertBenchmarkPiRuntimeMatchesSeed(piAgentHome.seedIdentity, benchmarkPiHomeConfigIdentity(runtime.path, { requiredFileMode: "600" })));
  rotated.other = { type: "oauth", access: "different-account" };
  fs.writeFileSync(path.join(runtime.path, "auth.json"), `${JSON.stringify(rotated)}\n`, { mode: 0o600 });
  assert.throws(() => assertBenchmarkPiRuntimeMatchesSeed(piAgentHome.seedIdentity, benchmarkPiHomeConfigIdentity(runtime.path, { requiredFileMode: "600" })), /provider, type, or account changed/);
  delete rotated.other;
  fs.writeFileSync(path.join(runtime.path, "auth.json"), `${JSON.stringify(rotated)}\n`, { mode: 0o600 });
  resetBenchmarkPiRuntimeEphemeralState(runtime);
  assert.deepEqual(fs.readdirSync(runtime.path).sort(), ["auth.json", "models.json", "settings.json"]);
  fs.mkdirSync(path.join(runtime.path, "npm"));
  let executableStateError;
  assert.throws(() => benchmarkPiHomeConfigIdentity(runtime.path, { requiredFileMode: "600" }), (error) => {
    executableStateError = error;
    return /forbidden executable package state/.test(error.message);
  });
  assert.deepEqual(executableStateError.piHomeMismatch, { classification: "forbidden-executable-state", entry: "npm", observedKind: "directory" });
  fs.rmSync(path.join(runtime.path, "npm"), { recursive: true });
  fs.writeFileSync(path.join(runtime.path, "settings.json"), '{"theme":"light"}\n', { mode: 0o600 });
  let behaviorError;
  assert.throws(() => assertBenchmarkPiRuntimeMatchesSeed(piAgentHome.seedIdentity, benchmarkPiHomeConfigIdentity(runtime.path, { requiredFileMode: "600" })), (error) => {
    behaviorError = error;
    return /behavioral configuration changed/.test(error.message);
  });
  assert.deepEqual(behaviorError.piHomeMismatch, { classification: "behavioral-content", entry: "settings.json" });
  cleanupBenchmarkPiRuntimeHome(piAgentHome, runtime);
  assert.equal(fs.existsSync(runtime.path), false);
});

test("Pi OAuth refresh uses a same-account locked CAS bridge and supports crash recovery", (t) => {
  const { piAgentHome } = controlledHome(t);
  const runtime = createBenchmarkPiRuntimeHome(piAgentHome);
  const authPath = path.join(runtime.path, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  auth.test.refresh = "rotated";
  fs.writeFileSync(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
  const bridge = acquireBenchmarkPiCredentialWriteback(piAgentHome);
  assert.equal(fs.existsSync(`${piAgentHome.operatorAuth.path}.lock`), true);
  assert.equal(bridge.commit(runtime), true);
  bridge.release();
  assert.equal(JSON.parse(fs.readFileSync(piAgentHome.operatorAuth.path, "utf8")).test.refresh, "rotated");
  fs.mkdirSync(`${piAgentHome.operatorAuth.path}.lock`, { mode: 0o700 });
  fs.writeFileSync(path.join(`${piAgentHome.operatorAuth.path}.lock`, "benchmark-owner.json"), `${JSON.stringify({ schemaVersion: 1, hostname: os.hostname(), pid: 99_999_999 })}\n`, { mode: 0o600 });
  recoverBenchmarkPiCredentialWriteback(piAgentHome);
  assert.equal(fs.existsSync(`${piAgentHome.operatorAuth.path}.lock`), false, "crash recovery must release a dead post-CAS lock");
  auth.test.refresh = "rotated-again";
  fs.writeFileSync(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
  recoverBenchmarkPiCredentialWriteback(piAgentHome);
  assert.equal(JSON.parse(fs.readFileSync(piAgentHome.operatorAuth.path, "utf8")).test.refresh, "rotated-again");
  cleanupBenchmarkPiRuntimeHome(piAgentHome, runtime);
});

test("Pi OAuth CAS rejects account switching and preserves the operator credential", (t) => {
  const { piAgentHome } = controlledHome(t);
  const runtime = createBenchmarkPiRuntimeHome(piAgentHome);
  const authPath = path.join(runtime.path, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  auth.test.accountId = "different-account";
  auth.test.refresh = "attacker-refresh";
  fs.writeFileSync(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
  const before = fs.readFileSync(piAgentHome.operatorAuth.path, "utf8");
  const bridge = acquireBenchmarkPiCredentialWriteback(piAgentHome);
  assert.throws(() => bridge.commit(runtime), /account identity/);
  bridge.release();
  assert.equal(fs.readFileSync(piAgentHome.operatorAuth.path, "utf8"), before);
  cleanupBenchmarkPiRuntimeHome(piAgentHome, runtime);
});

test("Pi OAuth CAS rejects operator-source drift and recovers its own dead lock owner", (t) => {
  const { piAgentHome } = controlledHome(t);
  const runtime = createBenchmarkPiRuntimeHome(piAgentHome);
  const runtimeAuthPath = path.join(runtime.path, "auth.json");
  const runtimeAuth = JSON.parse(fs.readFileSync(runtimeAuthPath, "utf8"));
  runtimeAuth.test.refresh = "runtime-rotated";
  fs.writeFileSync(runtimeAuthPath, `${JSON.stringify(runtimeAuth)}\n`, { mode: 0o600 });
  const bridge = acquireBenchmarkPiCredentialWriteback(piAgentHome);
  const operatorAuth = JSON.parse(fs.readFileSync(piAgentHome.operatorAuth.path, "utf8"));
  operatorAuth.test.refresh = "external-rotation";
  fs.writeFileSync(piAgentHome.operatorAuth.path, `${JSON.stringify(operatorAuth)}\n`, { mode: 0o600 });
  assert.throws(() => bridge.commit(runtime), /changed while the benchmark held/);
  bridge.release();
  piAgentHome.operatorAuth.identity = benchmarkPiCredentialFileIdentity(piAgentHome.operatorAuth.path);
  fs.mkdirSync(`${piAgentHome.operatorAuth.path}.lock`, { mode: 0o700 });
  fs.writeFileSync(path.join(`${piAgentHome.operatorAuth.path}.lock`, "benchmark-owner.json"), `${JSON.stringify({ schemaVersion: 1, hostname: os.hostname(), pid: 99_999_999 })}\n`, { mode: 0o600 });
  const recovered = acquireBenchmarkPiCredentialWriteback(piAgentHome);
  recovered.release();
  assert.equal(fs.existsSync(`${piAgentHome.operatorAuth.path}.lock`), false);
  cleanupBenchmarkPiRuntimeHome(piAgentHome, runtime);
});

test("Pi seed identity is private, detects seed/type drift, and exposes no auth-derived public digest", (t) => {
  const { piAgentHome } = controlledHome(t);
  const publicBefore = benchmarkPiHomePublicIdentity(piAgentHome.configRoot, [{ providerId: "test", type: "oauth" }]);
  const rawAuthHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(piAgentHome.configRoot, "auth.json"))).digest("hex");
  assert.equal(JSON.stringify(publicBefore).includes(rawAuthHash), false);
  fs.chmodSync(piAgentHome.configRoot, 0o700);
  fs.chmodSync(path.join(piAgentHome.configRoot, "auth.json"), 0o600);
  fs.writeFileSync(path.join(piAgentHome.configRoot, "auth.json"), '{"test":{"type":"oauth","access":"CHANGED","refresh":"changed"}}\n');
  fs.chmodSync(path.join(piAgentHome.configRoot, "auth.json"), 0o400);
  fs.chmodSync(piAgentHome.configRoot, 0o500);
  const publicAfter = benchmarkPiHomePublicIdentity(piAgentHome.configRoot, [{ providerId: "test", type: "oauth" }]);
  assert.deepEqual(publicAfter, publicBefore, "public evidence must not fingerprint credential bytes");
  assert.throws(
    () => assertBenchmarkPiHomeConfigIdentity(piAgentHome.seedIdentity, benchmarkPiHomeConfigIdentity(piAgentHome.configRoot, { requiredFileMode: "400" })),
    /bound configuration changed/
  );
  fs.chmodSync(piAgentHome.configRoot, 0o700);
  fs.symlinkSync("settings.json", path.join(piAgentHome.configRoot, "unbound-link"));
  let unexpected;
  assert.throws(() => benchmarkPiHomeConfigIdentity(piAgentHome.configRoot, { requiredFileMode: "400" }), (error) => {
    unexpected = error;
    return /unbound non-ephemeral path/.test(error.message);
  });
  assert.deepEqual(unexpected.piHomeMismatch, { classification: "unexpected-entry" }, "unknown filenames must not enter persistent diagnostics");
});

test("the installed Pi host completes a provider-free session with only bound operational state", { skip: !executableOnPath("pi") }, async (t) => {
  const pi = executableOnPath("pi");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-real-host-home-"));
  const configRoot = path.join(root, "seed");
  const runtimeParent = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  const shellHome = path.join(root, "shell-home");
  for (const directory of [configRoot, runtimeParent, workspace, sessions, shellHome]) fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => {
    try { fs.chmodSync(configRoot, 0o700); } catch { /* Already removed. */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const server = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      const base = { id: "local", object: "chat.completion.chunk", created: 1, model: "local-1" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const port = server.address().port;
  const models = {
    providers: {
      local: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-test-only",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "local-1", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
      }
    }
  };
  fs.writeFileSync(path.join(configRoot, "auth.json"), `${JSON.stringify({ "openai-codex": { type: "oauth", access: "synthetic", refresh: "synthetic", expires: Date.now() + 3_600_000, accountId: "synthetic-account" } })}\n`, { mode: 0o400 });
  fs.writeFileSync(path.join(configRoot, "settings.json"), "{}\n", { mode: 0o400 });
  fs.writeFileSync(path.join(configRoot, "models.json"), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o400 });
  fs.chmodSync(configRoot, 0o500);
  fs.mkdirSync(path.join(workspace, ".pi"), { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# Provider-free host regression\n", { mode: 0o600 });

  const piAgentHome = {
    configRoot,
    runtimeParent,
    seedIdentity: benchmarkPiHomeConfigIdentity(configRoot, { requiredFileMode: "400" })
  };
  const runtime = createBenchmarkPiRuntimeHome(piAgentHome);
  const child = spawn(pi, [
    "--print", "--mode", "json", "--session-dir", sessions,
    "--session-id", "00000000-0000-4000-8000-000000000082", "--name", "BENCH provider-free host",
    "--approve", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-context-files",
    "--append-system-prompt", path.join(workspace, "AGENTS.md"),
    "--extension", path.join(repositoryRoot, "packages/piagent-core/extensions/piagent-guard.ts"),
    "--skill", path.join(repositoryRoot, "packages/piagent-core/skills"),
    "--model", "local/local-1", "hello"
  ], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: shellHome,
      TMPDIR: os.tmpdir(),
      PI_CODING_AGENT_DIR: runtime.path,
      PI_OFFLINE: "1",
      PIAGENT_NO_UPDATE_CHECK: "1",
      PIAGENT_BENCHMARK_RUN_ID: "provider-free",
      PIAGENT_BENCHMARK_SCENARIO: "provider-free",
      PIAGENT_BENCHMARK_SURFACE: "piagent",
      PIAGENT_BENCHMARK_SESSION_ID: "00000000-0000-4000-8000-000000000082",
      PIAGENT_BENCHMARK_PROFILE: "benchmark",
      PIAGENT_BENCHMARK_LIFECYCLE: "steady-state",
      NO_COLOR: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);

  const observed = benchmarkPiHomeConfigIdentity(runtime.path, { requiredFileMode: "600" });
  assert.doesNotThrow(() => assertBenchmarkPiRuntimeMatchesSeed(piAgentHome.seedIdentity, observed));
  assert.equal(fs.existsSync(path.join(runtime.path, "models-store.json")), true, "real Pi should exercise the explicitly bound catalog store");
  assert.equal(fs.readdirSync(runtime.path).some((name) => name.endsWith(".lock")), false, "real Pi must release every home lock before close");
  resetBenchmarkPiRuntimeEphemeralState(runtime);
  assert.deepEqual(fs.readdirSync(runtime.path).sort(), ["auth.json", "models.json", "settings.json"]);
  cleanupBenchmarkPiRuntimeHome(piAgentHome, runtime);
});
