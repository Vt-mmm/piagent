import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildOpenAiCodexWireFingerprint } from "../packages/piagent-core/runtime/model/provider-wire-fingerprint.ts";
import { assertCodexRuntimeCredential, createCodexRuntime
} from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { runBenchmarkSession, runOfflineBenchmarkSession } from "../scripts/benchmark-session.mjs";
import { BENCHMARK_SCOPED_SESSION_FACTORY_VERSION } from "../scripts/benchmark-codex-journey.mjs";
import { fakeProvider } from "./fixtures/benchmark-candidate-ablation-fake.mjs";
const wire = await import(process.env.PIAGENT_TEST_WIRE_MODULE_PATH
  ? pathToFileURL(process.env.PIAGENT_TEST_WIRE_MODULE_PATH).href
  : "../packages/piagent-core/benchmark/benchmark-provider-wire.js");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const codexTurn = (threadId, inputTokens, outputTokens) => [
  { type: "thread.started", thread_id: threadId },
  { type: "item.completed", item: { id: `message-${inputTokens}`, type: "agent_message", text: "done" } },
  { type: "turn.completed", usage: { input_tokens: inputTokens, cached_input_tokens: 2,
    cache_write_input_tokens: 0, output_tokens: outputTokens, reasoning_output_tokens: 1 } }
].map(JSON.stringify).join("\n") + "\n";
const GRAPH = { intake: ["scout", "plan", "execute", "review", "handoff", "terminal"],
  scout: ["plan", "review", "handoff", "terminal"], plan: ["execute", "review", "handoff", "terminal"],
  execute: ["verify", "repair", "handoff", "terminal"], verify: ["repair", "review", "handoff", "terminal"],
  repair: ["verify", "handoff", "terminal"], review: ["repair", "handoff", "terminal"], handoff: ["terminal"], terminal: [] };
const payload = { model: "gpt-5.6-luna", instructions: "Public bounded projection.", tools: [], input: [],
  tool_choice: "auto", reasoning: { effort: "medium" }, text: { verbosity: "low" }, service_tier: "priority" };
function manifest(directory, pin) {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return { schemaVersion: 1, protocol: "phase-valid-configuration-v1", source: "pinned-host-definitions",
    candidateDigest: hash("candidate"), definitionDigest: hash("definition"), workingDirectory: directory,
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", requestedTier: "fast", requestTier: "priority",
    states: [{ id: "public-plan", operatorInputHash: hash("public request"), inputHash: hash("/plan public request"), phase: null,
      taskPresence: "none", selectedTools: [], fingerprint: buildOpenAiCodexWireFingerprint({ payload,
        provider: "openai-codex", modelId: payload.model, workingDirectory: directory, platformRoot: directory }) }],
    allowedEdges: structuredClone(GRAPH), pins: [{ path: pin, sha256: hash(fs.readFileSync(pin)) }],
    configurationDigest: hash("configuration"), receiptPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wire-manifest-test-")));
  fs.chmodSync(root, 0o700); const project = path.join(root, "project"); fs.mkdirSync(project, { mode: 0o700 });
  const pin = path.join(root, "public-definition.js"); fs.writeFileSync(pin, "export const definition = 1;\n");
  const value = manifest(project, pin), file = path.join(root, "definition-plan.json");
  const write = () => { const bytes = JSON.stringify(value); fs.writeFileSync(file, bytes, { mode: 0o600 }); return hash(bytes); };
  const digest = write();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project, pin, value, file, digest, write };
}
const rejection = /Benchmark wire manifest rejected:/;

test("wire final manifest requires exact public identity, graph, key and fingerprint", t => {
  const f = fixture(t);
  assert.equal(wire.validateBenchmarkWireManifest(f.value), f.value);
  assert.equal(wire.benchmarkWireManifestDigest(f.value), hash(JSON.stringify(f.value)));
  for (const mutate of [m => { m.model = "openai-codex/gpt-5.6-sol"; }, m => { m.requestTier = "default"; },
    m => { m.allowedEdges.execute.push("intake"); }, m => { m.receiptPublicKey = "AAAA"; },
    m => { m.states[0].fingerprint.requestPrefixFingerprint = hash("forged"); }]) {
    const changed = structuredClone(f.value); mutate(changed);
    assert.throws(() => wire.validateBenchmarkWireManifest(changed), rejection);
  }
});

test("wire template is explicitly non-final and avoids configuration/key digest cycles", t => {
  const f = fixture(t), plan = structuredClone(f.value);
  delete plan.configurationDigest; delete plan.receiptPublicKey;
  assert.equal(wire.validateBenchmarkWireManifest(plan, { template: true }), plan);
  assert.throws(() => wire.validateBenchmarkWireManifest(plan), rejection);
  assert.equal(wire.benchmarkWireDefinitionPlanDigest(plan), wire.benchmarkWireDefinitionPlanDigest(f.value));
  const changed = structuredClone(plan); changed.states[0].operatorInputHash = hash("different public input");
  assert.notEqual(wire.benchmarkWireDefinitionPlanDigest(plan), wire.benchmarkWireDefinitionPlanDigest(changed));
});

test("wire states reject wildcard/unknown/duplicate selectors and task ambiguity", t => {
  const f = fixture(t);
  for (const mutate of [m => { m.states[0].taskPresence = "*"; }, m => { m.states[0].phase = "execute"; },
    m => { m.states[0].taskPresence = "current"; }, m => { m.states[0].inputHash = "*"; },
    m => { m.states.push({ ...structuredClone(m.states[0]), id: "second" }); },
    m => { m.states[0].extraEndpointPermission = true; }]) {
    const changed = structuredClone(f.value); mutate(changed);
    assert.throws(() => wire.validateBenchmarkWireManifest(changed), rejection);
  }
});

test("wire binding mismatch and missing/duplicate definition pins fail closed", t => {
  const f = fixture(t);
  assert.throws(() => wire.validateBenchmarkWireManifest(f.value, { candidateDigest: hash("other") }), rejection);
  assert.throws(() => wire.validateBenchmarkWireManifest(f.value, { configurationDigest: hash("other") }), rejection);
  assert.throws(() => wire.validateBenchmarkWireManifest({ ...f.value, pins: [] }), rejection);
  assert.throws(() => wire.validateBenchmarkWireManifest({ ...f.value, pins: [...f.value.pins, ...f.value.pins] }), rejection);
  const withPlatform = { ...f.value, platformRoot: f.root };
  assert.equal(wire.validateBenchmarkWireManifest(withPlatform, { platformRoot: f.root }), withPlatform);
  assert.throws(() => wire.validateBenchmarkWireManifest(withPlatform, { platformRoot: "/different/platform" }), rejection);
  assert.throws(() => wire.validateBenchmarkWireManifest({ ...withPlatform, platformRoot: "/different/platform" }), rejection);
});

test("public SDK projection uses selected registered definitions and rejects silent unknown/deferred tools", () => {
  let active = [], selections = 0;
  const definitions = new Map([["read", { name: "read", description: "Read public text.", parameters: { type: "object", properties: { path: { type: "string" } } } }]]);
  const session = { getToolDefinition: name => definitions.get(name), setActiveToolsByName: names => { selections++; active = [...names]; },
    getActiveToolNames: () => active, get systemPrompt() { return `Public tools: ${active.join(",")}`; } };
  const arguments_ = { session, convertResponsesTools: tools => tools.map(tool => ({ type: "function", ...tool, strict: null })),
    fingerprint: buildOpenAiCodexWireFingerprint, rewriteInstructions: value => value,
    projection: { disposition: "known", id: "pre-task", operatorInputHash: hash("request"), inputHash: hash("request"), phase: null,
      taskPresence: "none", selectedTools: ["read"], compactMode: null }, model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    workingDirectory: "/public/project", platformRoot: "/public/platform" };
  const first = wire.projectBenchmarkWireState(arguments_);
  assert.equal(first.fingerprint.toolCount, 1); assert.equal(selections, 1);
  definitions.get("read").description += " Changed.";
  assert.notEqual(wire.projectBenchmarkWireState(arguments_).fingerprint.orderedToolSurfaceHash, first.fingerprint.orderedToolSurfaceHash);
  definitions.get("read").deferLoading = true;
  assert.throws(() => wire.projectBenchmarkWireState(arguments_), rejection);
  arguments_.projection.selectedTools = ["missing"];
  assert.throws(() => wire.projectBenchmarkWireState(arguments_), rejection);
  arguments_.projection.disposition = "blocked";
  assert.throws(() => wire.projectBenchmarkWireState(arguments_), rejection);
});

test("unconfigured wire helpers perform no invocation or file admission", () => {
  assert.equal(wire.readBenchmarkWireDefinitionPlan(), null);
  assert.equal(wire.freezeBenchmarkWireInvocation({ plan: null }), null);
  assert.equal(wire.readBenchmarkWireReceipts(null), null);
});

test("wire plan rejects mutated bytes, permissions, symlinks and hard links", t => {
  const f = fixture(t);
  assert.equal(wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest }).manifest.model, f.value.model);
  assert.throws(() => wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: hash("other") }), rejection);
  fs.chmodSync(f.file, 0o644);
  assert.throws(() => wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest }), rejection);
  fs.chmodSync(f.file, 0o600);
  const link = path.join(f.root, "plan-link.json"); fs.symlinkSync(f.file, link);
  assert.throws(() => wire.readBenchmarkWireDefinitionPlan({ file: link, sha256: f.digest }), rejection);
  fs.unlinkSync(link); fs.linkSync(f.file, link);
  assert.throws(() => wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest }), rejection);
});

test("definition source drift is rejected before private custody is created", t => {
  const f = fixture(t), plan = wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest });
  const before = fs.readdirSync(f.root);
  fs.writeFileSync(f.pin, "export const definition = 2;\n");
  assert.throws(() => wire.freezeBenchmarkWireInvocation({ plan, workingDirectory: f.project, custodyRoot: f.root,
    configurationDigest: f.value.configurationDigest, candidateDigest: f.value.candidateDigest }), rejection);
  assert.deepEqual(fs.readdirSync(f.root), before);
});

test("fresh invocation keys and exact manifest are durable outside project before admission", t => {
  const f = fixture(t), plan = wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest });
  const args = { plan, workingDirectory: f.project, custodyRoot: f.root,
    configurationDigest: f.value.configurationDigest, candidateDigest: f.value.candidateDigest };
  const first = wire.freezeBenchmarkWireInvocation(args), second = wire.freezeBenchmarkWireInvocation(args);
  assert.notEqual(first.manifest.receiptPublicKey, second.manifest.receiptPublicKey);
  assert.notEqual(first.manifestDigest, second.manifestDigest);
  assert.equal(hash(fs.readFileSync(first.files.manifest)), first.environment.PIAGENT_WIRE_MANIFEST_SHA256);
  assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
  for (const file of Object.values(first.files)) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(first.files.receipts, "utf8"), "");
  assert.ok(!JSON.stringify(first.manifest).includes("PRIVATE KEY"));
  assert.ok(!first.directory.startsWith(f.project + path.sep));
  const key = crypto.createPrivateKey(fs.readFileSync(first.files.signingKey));
  assert.equal(crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"), first.manifest.receiptPublicKey);
});

test("wrong cwd/config/candidate, stale in-memory plan and inside-project custody reject", t => {
  const f = fixture(t), plan = wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest });
  const args = { plan, workingDirectory: f.project, custodyRoot: f.root,
    configurationDigest: f.value.configurationDigest, candidateDigest: f.value.candidateDigest };
  assert.throws(() => wire.freezeBenchmarkWireInvocation({ ...args, workingDirectory: f.root }), rejection);
  assert.throws(() => wire.freezeBenchmarkWireInvocation({ ...args, configurationDigest: hash("other") }), rejection);
  assert.throws(() => wire.freezeBenchmarkWireInvocation({ ...args, candidateDigest: hash("other") }), rejection);
  assert.throws(() => wire.freezeBenchmarkWireInvocation({ ...args, custodyRoot: f.project }), rejection);
  const insideFile = path.join(f.project, "definition-plan.json"); fs.copyFileSync(f.file, insideFile); fs.chmodSync(insideFile, 0o600);
  const insidePlan = wire.readBenchmarkWireDefinitionPlan({ file: insideFile, sha256: f.digest });
  assert.throws(() => wire.freezeBenchmarkWireInvocation({ ...args, plan: insidePlan }), rejection);
  plan.manifest.states[0].inputHash = hash("changed");
  assert.throws(() => wire.freezeBenchmarkWireInvocation(args), rejection);
});

test("receipt retention does not label empty/unverified signed material as a passed gate", t => {
  const f = fixture(t), plan = wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest });
  const invocation = wire.freezeBenchmarkWireInvocation({ plan, workingDirectory: f.project, custodyRoot: f.root,
    configurationDigest: f.value.configurationDigest, candidateDigest: f.value.candidateDigest });
  const empty = wire.readBenchmarkWireReceipts(invocation);
  assert.equal(empty.state, "unverified-host-receipts"); assert.deepEqual(empty.receipts, []);
  const material = JSON.stringify({ sequence: 1, previousReceiptHash: null, manifestDigest: invocation.manifestDigest });
  const signature = crypto.sign(null, Buffer.from(material), crypto.createPrivateKey(fs.readFileSync(invocation.files.signingKey))).toString("base64");
  fs.appendFileSync(invocation.files.receipts, JSON.stringify({ material, signature }) + "\n");
  assert.equal(wire.readBenchmarkWireReceipts(invocation).receipts.length, 1);
  fs.appendFileSync(invocation.files.receipts, "{");
  assert.throws(() => wire.readBenchmarkWireReceipts(invocation), rejection);
});

test("manifest custody drift after provider return cannot become completion evidence", t => {
  const f = fixture(t), plan = wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest });
  const invocation = wire.freezeBenchmarkWireInvocation({ plan, workingDirectory: f.project, custodyRoot: f.root,
    configurationDigest: f.value.configurationDigest, candidateDigest: f.value.candidateDigest });
  fs.appendFileSync(invocation.files.manifest, " ");
  assert.throws(() => wire.readBenchmarkWireReceipts(invocation), rejection);
});

function sessionFixture(t, onDispatch = () => {}) {
  const f = fixture(t), runRoot = path.join(f.root, "run"), home = path.join(f.root, "home"), suiteRoot = path.join(f.root, "suite");
  for (const directory of [runRoot, home, suiteRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(suiteRoot, "fixture"));
  fs.writeFileSync(path.join(suiteRoot, "fixture/package.json"), '{"name":"wire-bridge-fake"}\n');
  fs.writeFileSync(path.join(suiteRoot, "prompt.md"), "Public synthetic bridge fixture only.\n");
  fs.writeFileSync(path.join(suiteRoot, "grade.mjs"), "// Fake evaluator seam, never executed.\n");
  f.value.workingDirectory = path.join(runRoot, "workspaces/01-wire-fake-piagent/project"); f.digest = f.write();
  const plan = wire.readBenchmarkWireDefinitionPlan({ file: f.file, sha256: f.digest });
  const fake = fakeProvider({ onDispatch });
  const scenario = { id: "wire-fake", kind: "safety-refusal", lifecycle: "cold-start", fixture: "fixture", prompt: "prompt.md",
    grader: "grade.mjs", allowedChanges: [], userJourney: { turns: [{ id: "first", prompt: "prompt.md" }], expectedTerminalSettlement: "completed" } };
  const options = { packageRoot: path.resolve(import.meta.dirname, ".."), runCommand: fake.runCommand,
    resolveSuiteEntry: (root, file) => path.join(root, file), interrupted: () => false, persistCompletedRecord: () => {},
    suite: { id: "wire-synthetic", profile: "node-typescript" }, suiteRoot, scenario, surface: "piagent", repeat: 1, orderIndex: 1,
    runId: "wire-offline", runRoot, options: { timeoutSeconds: 30, model: f.value.model, thinking: "medium", serviceTier: "fast", piagentTreatment: "release-defaults" },
    providerWirePlan: plan, candidateDigest: f.value.candidateDigest, piCommand: "offline-fake-pi", piRuntimeHome: { path: home },
    systemCommands: { node: "offline-fake-node", git: "offline-fake-git", bash: "offline-fake-bash" },
    suiteDigest: hash("synthetic-suite"), configurationDigest: f.value.configurationDigest, rootSeed: "synthetic-seed",
    assertProviderDispatchReady: () => {},
    onAfterProviderDispatch: () => {},
    piagentWebUiJourney: fake.piagentWebUiJourney };
  return { ...f, runRoot, options, plan };
}

function codexJourneySessionFixture(t, onCodexDispatch = () => {}) {
  const f = fixture(t), runRoot = path.join(f.root, "codex-run"), codexHome = path.join(f.root, "codex-home"),
    suiteRoot = path.join(f.root, "codex-suite");
  for (const directory of [runRoot, codexHome, suiteRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(suiteRoot, "fixture"));
  fs.writeFileSync(path.join(suiteRoot, "fixture/package.json"), '{"name":"codex-journey-fake"}\n');
  fs.writeFileSync(path.join(suiteRoot, "first.md"), "First turn.\n");
  fs.writeFileSync(path.join(suiteRoot, "second.md"), "Second turn.\n");
  fs.writeFileSync(path.join(suiteRoot, "grade.mjs"), "// Fake evaluator seam, never executed.\n");
  const offline = fakeProvider(), threadId = "019abcde-1234-7000-8000-0123456789ab";
  let providerCalls = 0;
  const runCommand = async (command, args, options) => {
    if (command !== "offline-fake-codex") return offline.runCommand(command, args, options);
    providerCalls++;
    onCodexDispatch({ providerCalls, args, options });
    const stdout = codexTurn(threadId, 10 + providerCalls, 2 + providerCalls);
    options.onStdoutChunk(stdout, { observedAtSeconds: 0.01 });
    return { code: 0, stdout, stderr: "", signal: null, timedOut: false, durationSeconds: 0.01,
      forbiddenHits: [] };
  };
  const scenario = { id: "codex-journey-fake", kind: "safety-refusal", lifecycle: "cold-start",
    fixture: "fixture", prompt: "first.md", grader: "grade.mjs", allowedChanges: [],
    userJourney: { turns: [{ id: "first", prompt: "first.md" }, { id: "second", prompt: "second.md" }],
      expectedTerminalSettlement: "completed" } };
  return { ...f, runRoot, providerCalls: () => providerCalls, inflightPath: path.join(runRoot, "workspaces",
    "01-codex-journey-fake-codex-cli", "inflight.json"), options: {
    packageRoot: path.resolve(import.meta.dirname, ".."), runCommand,
    resolveSuiteEntry: (root, file) => path.join(root, file), interrupted: () => false,
    persistCompletedRecord: () => {}, suite: { id: "codex-journey-synthetic", profile: "node-typescript" },
    suiteRoot, scenario, surface: "codex-cli", repeat: 1, orderIndex: 1, runId: "codex-journey-offline",
    runRoot, options: { timeoutSeconds: 30, model: "openai-codex/gpt-5.6-luna", thinking: "medium",
      codexMode: "controlled", piagentTreatment: "release-defaults" },
    piCommand: "offline-fake-pi", codexCommand: "offline-fake-codex", codexDisabledFeatures: [],
    codexRuntime: { mode: "controlled", home: codexHome },
    systemCommands: { node: "offline-fake-node", git: "offline-fake-git", bash: "offline-fake-bash" },
    suiteDigest: hash("codex-journey-suite"), configurationDigest: hash("codex-journey-configuration"),
    assertProviderDispatchReady: () => {},
    onAfterProviderDispatch: () => {},
    rootSeed: "codex-journey-seed"
  } };
}

function frozenCodexRuntime(t, root) {
  const source = path.join(root, "frozen-codex-auth.json");
  fs.writeFileSync(source, "synthetic frozen Codex credential\n", { mode: 0o600 });
  const previous = process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT;
  let runtime;
  try {
    process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT = source;
    runtime = createCodexRuntime({ surfaces: ["codex-cli"], codexMode: "controlled",
      registeredMeasurement: "/synthetic/registered-measurement.json" });
  } finally {
    if (previous === undefined) delete process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT;
    else process.env.PIAGENT_BENCHMARK_CODEX_AUTH_SNAPSHOT = previous;
  }
  t.after(() => { if (runtime && fs.existsSync(runtime.home)) runtime.cleanup(); });
  return runtime;
}

test("multi-turn Codex session admits once immediately before dispatch and journals return after every turn", async t => {
  const events = [];
  let f;
  f = codexJourneySessionFixture(t, ({ providerCalls, args }) => {
    events.push(`provider-${providerCalls}:${JSON.parse(fs.readFileSync(f.inflightPath)).stage}`);
    if (providerCalls === 2) assert.deepEqual(args.slice(0, 3), ["exec", "resume", "--json"]);
  });
  const result = await runBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: ({ turnIndex }) => events.push(`guard-${turnIndex}`),
    onAfterProviderDispatch: ({ turnIndex }) => events.push(`post-${turnIndex}`),
    onProviderAttemptStart: () => events.push(`start:${JSON.parse(fs.readFileSync(f.inflightPath)).stage}`),
    onProviderAttemptReturned: () => events.push(`return:${JSON.parse(fs.readFileSync(f.inflightPath)).stage}`) });
  assert.deepEqual(events, ["guard-1", "start:provider-may-start", "provider-1:provider-may-start",
    "post-1", "guard-2", "provider-2:provider-may-start", "post-2", "return:provider-returned"]);
  assert.equal(f.providerCalls(), 2);
  assert.equal(result.record.journeyReceipt.completed, true);
  assert.equal(result.record.usage.turns, 2);
  assert.equal(result.record.usage.usageCompleteness, "exact");
});

test("per-turn Codex dispatch guard failure blocks the provider before campaign admission", async t => {
  let starts = 0;
  const f = codexJourneySessionFixture(t);
  await assert.rejects(runBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: () => { throw new Error("provider-dispatch-integrity-denied"); },
    onProviderAttemptStart: () => starts++ }), /provider-dispatch-integrity-denied/);
  assert.equal(f.providerCalls(), 0);
  assert.equal(starts, 0);
  assert.equal(fs.existsSync(f.inflightPath), false);
});

test("direct Codex credential mutation is fatal before output or usage admission", async t => {
  let runtime, marker = null, postChecks = 0, starts = 0, returns = 0, persisted = 0;
  const f = codexJourneySessionFixture(t, () => {
    fs.appendFileSync(path.join(runtime.home, "auth.json"), "credential drift during command\n");
  });
  runtime = frozenCodexRuntime(t, f.root);
  f.options.codexRuntime = runtime;
  delete f.options.scenario.userJourney;
  await assert.rejects(runBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: () => assertCodexRuntimeCredential(runtime, { required: true }),
    onAfterProviderDispatch: context => {
      postChecks++;
      assert.deepEqual(context, { turnIndex: 1, turnId: null });
      assert.equal(Object.isFrozen(context), true);
      assert.equal(fs.existsSync(runtime.home), true, "attempt HOME must still exist for the postcheck");
      try { assertCodexRuntimeCredential(runtime, { required: true }); }
      catch (error) { marker = error; throw error; }
    },
    onProviderAttemptStart: () => starts++,
    onProviderAttemptReturned: () => returns++,
    persistCompletedRecord: () => persisted++ }), error => error === marker);
  assert.equal(f.providerCalls(), 1);
  assert.deepEqual([postChecks, starts, returns, persisted], [1, 1, 0, 0]);
  assert.match(marker.message, /credential copy changed/);
  assert.equal(JSON.parse(fs.readFileSync(f.inflightPath)).stage, "provider-may-start");
  const attemptHome = runtime.home;
  runtime.cleanup();
  assert.equal(fs.existsSync(attemptHome), false, "cleanup is attempted only after the postcheck rejects");
});

test("second-turn Codex guard denial retains exact first-turn usage without another dispatch", async t => {
  const marker = Object.assign(new Error("second-turn-runtime-drift"), {
    code: "BENCHMARK_EXECUTION_ASSET_MISMATCH"
  });
  let starts = 0, returns = 0, returnedUsage = null, returnedUsageStatus = null;
  const f = codexJourneySessionFixture(t);
  const result = await runBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: async ({ turnIndex }) => {
      await Promise.resolve();
      if (turnIndex === 2) throw marker;
    },
    onProviderAttemptStart: () => starts++,
    onProviderAttemptReturned: value => {
      returns++; returnedUsage = value.usage; returnedUsageStatus = value.usageStatus;
    } });
  assert.equal(f.providerCalls(), 1);
  assert.equal(starts, 1);
  assert.equal(returns, 1);
  assert.equal(result.fatalProviderBoundaryError, marker);
  assert.equal(result.fatalProviderBoundaryPhase, "pre-dispatch");
  assert.equal(result.record.providerBoundaryPhase, "pre-dispatch");
  assert.equal(result.record.abortSuite, true);
  assert.equal(result.record.failure, "provider-dispatch-integrity-denied-before-next-turn");
  assert.equal(result.record.usageStatus, "measured-but-unaccepted");
  assert.equal(result.record.usage.sessions, 1);
  assert.equal(result.record.usage.turns, 1);
  assert.equal(result.record.usage.usageCompleteness, "exact");
  assert.deepEqual(returnedUsage, result.record.usage);
  assert.equal(returnedUsageStatus, "measured-but-unaccepted");
  assert.equal(result.record.journeyReceipt.completed, false);
  assert.equal(result.record.journeyReceipt.turns.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.inflightPath)).stage, "provider-returned");
});

test("second-turn Codex credential mutation retains only prior exact usage and disposes current custody", async t => {
  let runtime, marker = null, starts = 0, returns = 0, persisted = 0;
  let returnedUsage = null, returnedUsageStatus = null;
  const postChecks = [], disposals = [], settlements = [];
  const f = codexJourneySessionFixture(t, ({ providerCalls }) => {
    if (providerCalls === 2) {
      fs.appendFileSync(path.join(runtime.home, "auth.json"), "credential drift during resumed command\n");
    }
  });
  runtime = frozenCodexRuntime(t, f.root);
  f.options.codexRuntime = runtime;
  f.options.codexScopedBroker = [1, 2].map(turn => ({
    codexLaunch: { nodeCommand: "/runtime/node", brokerScript: "/runtime/scoped-broker.mjs",
      brokerConfigPath: path.join(f.root, `turn-${turn}`, "broker-config.json") },
    assertPredispatch() { return true; },
    reconcileCodexSettlement() { settlements.push(turn); return { turn, reconciled: true }; },
    async dispose() { disposals.push(turn); }
  }));
  const result = await runBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: () => assertCodexRuntimeCredential(runtime, { required: true }),
    onAfterProviderDispatch: context => {
      postChecks.push({ ...context, frozen: Object.isFrozen(context), homeExists: fs.existsSync(runtime.home) });
      try { assertCodexRuntimeCredential(runtime, { required: true }); }
      catch (error) { marker = error; throw error; }
    },
    onProviderAttemptStart: () => starts++,
    onProviderAttemptReturned: value => {
      returns++; returnedUsage = value.usage; returnedUsageStatus = value.usageStatus;
    },
    persistCompletedRecord: () => persisted++ });
  assert.equal(f.providerCalls(), 2);
  assert.deepEqual([starts, returns, persisted], [1, 1, 0]);
  assert.deepEqual(postChecks, [
    { turnIndex: 1, turnId: "first", frozen: true, homeExists: true },
    { turnIndex: 2, turnId: "second", frozen: true, homeExists: true }
  ]);
  assert.deepEqual(disposals, [1, 2]);
  assert.deepEqual(settlements, [1], "the rejected current turn must not reach settlement");
  assert.equal(result.fatalProviderBoundaryError, marker);
  assert.equal(result.fatalProviderBoundaryPhase, "post-dispatch");
  assert.equal(result.record.providerBoundaryPhase, "post-dispatch");
  assert.match(marker.message, /credential copy changed/);
  assert.equal(result.record.abortSuite, true);
  assert.equal(result.record.failure, "provider-dispatch-integrity-denied-after-provider-return");
  assert.equal(result.record.usageStatus, "measured-lower-bound");
  assert.equal(result.record.usage.turns, 1);
  assert.equal(result.record.usage.usageCompleteness, "exact");
  assert.deepEqual(returnedUsage, result.record.usage);
  assert.equal(returnedUsageStatus, "measured-lower-bound");
  assert.equal(result.record.journeyReceipt.completed, false);
  assert.equal(result.record.journeyReceipt.turns.length, 1);
  assert.equal(result.record.agent.stdoutHash,
    hash(codexTurn("019abcde-1234-7000-8000-0123456789ab", 11, 3)));
  assert.equal(JSON.parse(fs.readFileSync(f.inflightPath)).stage, "provider-returned");
});

test("multi-turn Codex session retains pre-dispatch journal when admission callback fails", async t => {
  const f = codexJourneySessionFixture(t);
  await assert.rejects(runBenchmarkSession({ ...f.options,
    onProviderAttemptStart: () => { throw new Error("campaign-journal-denied"); } }), /campaign-journal-denied/);
  assert.equal(f.providerCalls(), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.inflightPath)).stage, "provider-may-start");
});

test("single-session bridge freezes custody before started callback and retains signed fake receipts", async t => {
  let starts = 0, returns = 0, calls = 0;
  const f = sessionFixture(t, ({ options }) => {
    calls++;
    const env = options.env, bytes = fs.readFileSync(env.PIAGENT_WIRE_MANIFEST_PATH);
    assert.equal(hash(bytes), env.PIAGENT_WIRE_MANIFEST_SHA256);
    const material = JSON.stringify({ sequence: 1, previousReceiptHash: null, manifestDigest: env.PIAGENT_WIRE_MANIFEST_SHA256 });
    const signature = crypto.sign(null, Buffer.from(material), crypto.createPrivateKey(fs.readFileSync(env.PIAGENT_WIRE_SIGNING_KEY_PATH))).toString("base64");
    fs.appendFileSync(env.PIAGENT_WIRE_RECEIPTS_PATH, JSON.stringify({ material, signature }) + "\n");
  });
  const result = await runOfflineBenchmarkSession({ ...f.options,
    onProviderAttemptStart: () => { starts++; assert.equal(fs.readdirSync(f.runRoot).filter(name => name.startsWith("provider-wire-")).length, 1); },
    onProviderAttemptReturned: value => { returns++; assert.equal(value.usage.fresh, 10); } });
  assert.deepEqual([starts, returns, calls], [1, 1, 1]);
  assert.equal(result.record.providerWirePhaseEvidence.state, "unverified-host-receipts");
  assert.equal(result.record.providerWirePhaseEvidence.receipts.length, 1);
  assert.equal(result.record.usage.fresh, 10);
  assert.ok(result.record.providerWireEvidence, "legacy raw telemetry evidence remains separate");
});

test("unconfigured single-session path keeps wire environment and receipt fields absent", async t => {
  let calls = 0;
  const f = sessionFixture(t, ({ options }) => {
    calls++;
    assert.deepEqual(Object.keys(options.env).filter(name => name.startsWith("PIAGENT_WIRE_")), []);
  });
  delete f.options.providerWirePlan; delete f.options.candidateDigest;
  const result = await runOfflineBenchmarkSession(f.options);
  assert.equal(calls, 1); assert.equal(Object.hasOwn(result.record, "providerWirePhaseEvidence"), false);
  assert.equal(fs.readdirSync(f.runRoot).filter(name => name.startsWith("provider-wire-")).length, 0);
});

test("direct dispatch guard failure blocks the provider before campaign admission", async t => {
  let starts = 0, calls = 0;
  const f = sessionFixture(t, () => calls++);
  delete f.options.scenario.userJourney;
  delete f.options.providerWirePlan;
  delete f.options.candidateDigest;
  const inflightPath = path.join(f.runRoot, "workspaces/01-wire-fake-piagent/inflight.json");
  await assert.rejects(runOfflineBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: () => { throw new Error("direct-provider-dispatch-integrity-denied"); },
    onProviderAttemptStart: () => starts++ }), /direct-provider-dispatch-integrity-denied/);
  assert.equal(calls, 0);
  assert.equal(starts, 0);
  assert.equal(fs.existsSync(inflightPath), false);
});

test("Pi WebUI async guard denial preserves the integrity error before command or admission", async t => {
  let starts = 0, calls = 0;
  const marker = Object.assign(new Error("pi-webui-runtime-drift"), {
    code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
    executionAsset: { stage: "provider-dispatch", asset: "candidate" }
  });
  const f = sessionFixture(t, () => calls++);
  await assert.rejects(runOfflineBenchmarkSession({ ...f.options,
    assertProviderDispatchReady: async () => { await Promise.resolve(); throw marker; },
    onProviderAttemptStart: () => starts++ }), error => error === marker);
  assert.equal(calls, 0);
  assert.equal(starts, 0);
  assert.equal(fs.existsSync(path.join(f.runRoot,
    "workspaces/01-wire-fake-piagent/inflight.json")), false);
});

test("second-turn Pi WebUI guard denial retains exact first-turn usage without another dispatch", async t => {
  const marker = Object.assign(new Error("pi-webui-second-turn-runtime-drift"), {
    code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
    executionAsset: { stage: "provider-dispatch", asset: "candidate" }
  });
  let starts = 0, returns = 0, calls = 0, persisted = 0;
  let returnedUsage = null, returnedUsageStatus = null;
  const guardContexts = [];
  const f = sessionFixture(t, () => calls++), baseJourney = f.options.piagentWebUiJourney;
  f.options.scenario.userJourney.turns.push({ id: "second", prompt: "prompt.md" });
  const piagentWebUiJourney = async input => {
    const first = await baseJourney({ ...input, turns: [input.turns[0]] });
    try {
      await input.onBeforeProviderDispatch(Object.freeze({ turnIndex: 2, turnId: input.turns[1].id }));
    } catch (error) {
      return { ...first, code: 1, stderr: error instanceof Error ? error.message : String(error),
        journeyReceipt: { ...first.journeyReceipt, completed: false,
          turns: [{ index: 1, assistantText: first.stdout }] },
        fatalProviderBoundaryError: error instanceof Error ? error : new Error(String(error)),
        fatalProviderBoundaryPhase: "pre-dispatch" };
    }
    throw new Error("second Pi WebUI dispatch unexpectedly admitted");
  };
  const result = await runOfflineBenchmarkSession({ ...f.options, piagentWebUiJourney,
    assertProviderDispatchReady: async context => {
      guardContexts.push({ turnIndex: context.turnIndex, turnId: context.turnId,
        frozen: Object.isFrozen(context) });
      await Promise.resolve();
      if (context.turnIndex === 2) throw marker;
    },
    onProviderAttemptStart: () => starts++,
    onProviderAttemptReturned: value => {
      returns++; returnedUsage = value.usage; returnedUsageStatus = value.usageStatus;
    },
    persistCompletedRecord: () => persisted++ });
  assert.deepEqual([calls, starts, returns, persisted], [1, 1, 1, 0]);
  assert.deepEqual(guardContexts, [
    { turnIndex: 1, turnId: "first", frozen: true },
    { turnIndex: 2, turnId: "second", frozen: true }
  ]);
  assert.equal(result.fatalProviderBoundaryError, marker);
  assert.equal(result.fatalProviderBoundaryPhase, "pre-dispatch");
  assert.equal(result.record.providerBoundaryPhase, "pre-dispatch");
  assert.equal(result.record.abortSuite, true);
  assert.equal(result.record.failure, "provider-dispatch-integrity-denied-before-next-turn");
  assert.equal(result.record.usageStatus, "measured-but-unaccepted");
  assert.equal(result.record.usage.sessions, 1);
  assert.equal(result.record.usage.messages, 1);
  assert.equal(result.record.usage.fresh, 10);
  assert.equal(result.record.usage.usageCompleteness, "exact");
  assert.deepEqual(returnedUsage, result.record.usage);
  assert.equal(returnedUsageStatus, "measured-but-unaccepted");
  assert.equal(result.record.journeyReceipt.completed, false);
  assert.equal(result.record.journeyReceipt.turns.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(result.inflightPath)).stage, "provider-returned");
});

test("second-turn Pi router custody fatal retains exact usage and cannot become accepted persistence", async t => {
  const marker = Object.assign(new Error("pi-webui-second-turn-custody-drift"), {
    code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
    brokerCode: "session-custody-arm-drift",
    executionAsset: { stage: "provider-dispatch", asset: "selected-pi-arm",
      reason: "arm-identity-mismatch" }
  });
  let starts = 0, returns = 0, calls = 0, persisted = 0;
  let returnedUsage = null, returnedUsageStatus = null;
  const guardContexts = [];
  const f = sessionFixture(t, () => calls++), baseJourney = f.options.piagentWebUiJourney;
  f.options.scenario.userJourney.turns.push({ id: "second", prompt: "prompt.md" });
  const piagentWebUiJourney = async input => {
    const first = await baseJourney({ ...input, turns: [input.turns[0]] });
    return { ...first, code: 1, stderr: marker.message,
      journeyReceipt: { ...first.journeyReceipt, completed: false,
        turns: [{ index: 1, assistantText: first.stdout }] },
      fatalProviderBoundaryError: marker, fatalProviderBoundaryPhase: "pre-dispatch" };
  };
  const result = await runOfflineBenchmarkSession({ ...f.options, piagentWebUiJourney,
    assertProviderDispatchReady: async context => {
      guardContexts.push({ turnIndex: context.turnIndex, turnId: context.turnId,
        frozen: Object.isFrozen(context) });
      await Promise.resolve();
    },
    onProviderAttemptStart: () => starts++,
    onProviderAttemptReturned: value => {
      returns++; returnedUsage = value.usage; returnedUsageStatus = value.usageStatus;
    },
    persistCompletedRecord: () => persisted++ });
  assert.deepEqual([calls, starts, returns, persisted], [1, 1, 1, 0]);
  assert.deepEqual(guardContexts, [{ turnIndex: 1, turnId: "first", frozen: true }]);
  assert.equal(result.fatalProviderBoundaryError, marker);
  assert.equal(result.fatalProviderBoundaryPhase, "pre-dispatch");
  assert.equal(result.record.providerBoundaryPhase, "pre-dispatch");
  assert.equal(result.record.abortSuite, true);
  assert.equal(result.record.failure, "provider-dispatch-integrity-denied-before-next-turn");
  assert.equal(result.record.usageStatus, "measured-but-unaccepted");
  assert.equal(result.record.usage.sessions, 1);
  assert.equal(result.record.usage.messages, 1);
  assert.equal(result.record.usage.fresh, 10);
  assert.equal(result.record.usage.usageCompleteness, "exact");
  assert.deepEqual(returnedUsage, result.record.usage);
  assert.equal(returnedUsageStatus, "measured-but-unaccepted");
  assert.equal(result.record.journeyReceipt.completed, false);
  assert.equal(result.record.journeyReceipt.turns.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(result.inflightPath)).stage, "provider-returned");
});

test("benchmark session rejects a missing dispatch guard before any provider work", async t => {
  const f = codexJourneySessionFixture(t);
  delete f.options.assertProviderDispatchReady;
  await assert.rejects(runBenchmarkSession(f.options), /requires an explicit integrity guard/);
  assert.equal(f.providerCalls(), 0);
});

test("single-session source drift blocks before dispatch or inflight admission", async t => {
  let starts = 0, calls = 0;
  const f = sessionFixture(t, () => calls++);
  fs.appendFileSync(f.pin, "// drift\n");
  await assert.rejects(runOfflineBenchmarkSession({ ...f.options, onProviderAttemptStart: () => starts++ }), rejection);
  assert.equal(starts, 0); assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(f.runRoot, "workspaces/01-wire-fake-piagent/inflight.json")), false);
});

test("registered session-custody denial blocks before provider admission", async t => {
  let starts = 0, calls = 0, opens = 0;
  const f = sessionFixture(t, () => calls++);
  const scopedBrokerSessionFactory = { version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION,
    authority: "none", async openSession(request) {
      opens++;
      assert.equal(request.surface, "piagent");
      assert.equal(request.scenarioId, "wire-fake");
      assert.equal(request.turns.length, 1);
      throw new Error("registered-session-custody-denied");
    } };
  await assert.rejects(runOfflineBenchmarkSession({ ...f.options, scopedBrokerSessionFactory,
    onProviderAttemptStart: () => starts++ }), /registered-session-custody-denied/);
  assert.deepEqual([opens, starts, calls], [1, 0, 0]);
  assert.equal(fs.existsSync(path.join(f.runRoot,
    "workspaces/01-wire-fake-piagent/inflight.json")), false);
  assert.equal(fs.readdirSync(f.runRoot).some(name => name.startsWith("provider-wire-")), false);
});

test("registered amendments bind identical exact turns to both arm session factories", async t => {
  const stableConfiguration = hash("registered-measurement-configuration");
  const registeredInput = Object.freeze({
    scenarioId: "wire-fake",
    role: "interaction",
    prompt: "AMENDED primary bytes with  double spaces.",
    turns: Object.freeze([
      Object.freeze({ id: "scout", message: "Registered scout bytes.\nSecond line.", workflow: "scout",
        reconnectBefore: false, receiptUncertain: false }),
      Object.freeze({ id: "implement", message: "AMENDED primary bytes with  double spaces.", workflow: "task",
        reconnectBefore: false, receiptUncertain: false }),
      Object.freeze({ id: "verify", message: "Registered verify bytes.", workflow: "review",
        reconnectBefore: true, receiptUncertain: true })
    ])
  });
  const verificationPlan = Object.freeze({ measurementConfigurationDigest: stableConfiguration,
    registeredInput(scenarioId) { assert.equal(scenarioId, "wire-fake"); return registeredInput; },
    prepare() { throw new Error("verification authority must not be reached after custody denial"); } });
  const observed = [];
  for (const surface of ["piagent", "codex-cli"]) {
    let starts = 0, calls = 0;
    const f = sessionFixture(t, () => calls++);
    const scopedBrokerSessionFactory = { version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION,
      authority: "none", async openSession(request) {
        observed.push({ surface: request.surface, configurationSha256: request.configurationSha256,
          turns: structuredClone(request.turns) });
        throw new Error(`registered-exact-input-observed-${surface}`);
      } };
    await assert.rejects(runOfflineBenchmarkSession({ ...f.options, surface, verificationPlan,
      scopedBrokerSessionFactory, onProviderAttemptStart: () => starts++ }),
    new RegExp(`registered-exact-input-observed-${surface}`));
    assert.deepEqual([starts, calls], [0, 0]);
  }
  assert.deepEqual(observed.map(item => item.surface), ["piagent", "codex-cli"]);
  assert.ok(observed.every(item => item.configurationSha256 === stableConfiguration));
  assert.deepEqual(observed[0].turns, observed[1].turns);
  assert.deepEqual(observed[0].turns, registeredInput.turns.map(turn => ({ ...turn })));
});

test("post-return wire custody failure retains exact spend in existing inflight journal", async t => {
  let starts = 0, returnedUsage = null, persisted = false;
  const f = sessionFixture(t, ({ options }) => fs.appendFileSync(options.env.PIAGENT_WIRE_MANIFEST_PATH, " "));
  await assert.rejects(runOfflineBenchmarkSession({ ...f.options, onProviderAttemptStart: () => starts++,
    onProviderAttemptReturned: value => { returnedUsage = value.usage; }, persistCompletedRecord: () => { persisted = true; } }), rejection);
  const inflight = JSON.parse(fs.readFileSync(path.join(f.runRoot, "workspaces/01-wire-fake-piagent/inflight.json")));
  assert.equal(starts, 1); assert.equal(returnedUsage.fresh, 10); assert.equal(persisted, false);
  assert.equal(inflight.stage, "provider-returned"); assert.equal(inflight.usage.fresh, 10);
});

test("wire configured CLI fallback is blocked instead of silently claiming WebUI qualification", async t => {
  let starts = 0, calls = 0;
  const f = sessionFixture(t, () => calls++); delete f.options.scenario.userJourney;
  await assert.rejects(runOfflineBenchmarkSession({ ...f.options, onProviderAttemptStart: () => starts++ }), /qualified Piagent WebUI route/);
  assert.equal(starts, 0); assert.equal(calls, 0);
});
