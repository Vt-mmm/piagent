import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { benchmarkVerificationBinding, benchmarkVerificationRequestDigest, loadBenchmarkVerificationPlan, validateBenchmarkVerificationPlan } from "../scripts/benchmark-independent-verification.mjs";
import { materializeBenchmarkCandidate } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { cleanupBenchmarkExecutionSnapshot } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { discoverRuntimeIntegrityFiles } from "../packages/piagent-core/capabilities/runtime-integrity.js";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { installedContractVerifierDigest, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { IndependentAcceptanceRuntime } from "../packages/piagent-core/runtime/verification/independent-acceptance-runtime.ts";
import { OPERATOR_REQUEST_MAX_CHARS, operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { redactSensitiveText } from "../packages/piagent-core/extensions/redaction-core.js";
import { registerWorkflowCommands } from "../packages/piagent-core/runtime/registration/workflow-commands.ts";
import { boundedOperatorRequest } from "../packages/piagent-core/runtime/registration/operator-request-intake.ts";
import { buildWebUiWorkflowCommand } from "../packages/piagent-core/runtime/workflows/webui-workflow.ts";
import { extractTaskRequest, looksLikeGovernedBoilerplate } from "../packages/piagent-core/runtime/workflows/input-routing.ts";
import { LONG_INPUT_CHARS } from "../packages/piagent-core/runtime/runtime-limits.ts";
import { resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { createRootSchemaRegistry } from "./helpers/root-schema-registry.mjs";
import { benchmarkResumeCommand } from "../scripts/benchmark-runner-support.mjs";
import { benchmarkVerificationRecordMatches, validBenchmarkVerificationObservation } from "../packages/piagent-core/benchmark/benchmark-independent-verification-observation.js";

const root = path.resolve(import.meta.dirname, "..");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-verification-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project"), suiteRoot = path.join(directory, "suite"), installedRoot = path.join(directory, "installed");
  for (const target of [projectRoot, suiteRoot, installedRoot]) fs.mkdirSync(target);
  fs.writeFileSync(path.join(installedRoot, "package.json"), "{}");
  for (const name of ["acceptance-authenticated-admission.js", "acceptance-durable-execution.js", "acceptance-host-configuration.js"]) {
    const target = path.join(installedRoot, "packages/piagent-core/extensions", name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "export const fixture=1;\n");
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/benchmark-independent-verification-plan.valid.json")));
  catalog.verifierDigest = installedContractVerifierDigest(installedRoot);
  const plan = catalog.scenarios[0].plans[0];
  plan.operatorRequestDigest = operatorRequestDigest("Preserve the number.");
  plan.contracts[0].sourcePath = "identity.js";
  if (imageId && dockerSocket) plan.backend = { imageId, dockerSocket, timeoutMs: 10000 };
  fs.writeFileSync(path.join(suiteRoot, "prompt.md"), "Preserve the number.\n");
  const scenarios = [{ id: "identity", prompt: "prompt.md" }, { id: "unconfigured", prompt: "prompt.md" }];
  const file = path.join(directory, "plan.json"), authority = path.join(directory, "authority");
  const save = () => fs.writeFileSync(file, JSON.stringify(catalog), { mode: 0o600 }); save();
  const options = { file, installedRoot, suiteDigest: catalog.suiteDigest, scenarios, suiteRoot, resolveSuiteEntry: resolveBenchmarkSuiteEntry };
  const load = (overrides = {}) => loadBenchmarkVerificationPlan({ ...options, ...overrides });
  const prepare = (loaded = load(), overrides = {}) => loaded.prepare({ scenarioId: "identity", surface: "piagent", projectRoot, directory: authority, approved: true, ...overrides });
  return { directory, projectRoot, suiteRoot, installedRoot, authority, file, catalog, plan, scenarios, options, save, load, prepare };
}

async function dispatchedJourneyRequest(workflow, request) {
  const commands = new Map(), sent = [];
  registerWorkflowCommands({}, {
    registerRuntimeCommand(_pi, name, definition) { commands.set(name, definition); },
    // Match the actual guard parser. Splitting and rejoining tokens would erase
    // newlines and silently change the operator-request digest in this test.
    commandArgs(raw) {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(String(raw ?? "").trim());
      const action = (match?.[1] ?? "").toLowerCase(), rest = match?.[2] ?? "";
      return { action, rest, tokens: rest.split(/\s+/).filter(Boolean) };
    },
    sendWorkflowFollowUp(value) { sent.push(value); }
  });
  const ingress = buildWebUiWorkflowCommand(workflow ?? null, request);
  if (workflow) await commands.get("workflow").handler(ingress.slice("/workflow ".length), { ui: { notify() {} } });
  else sent.push(ingress);
  assert.equal(sent.length, 1, "capture the real namespace dispatcher without a provider or authority write");
  const dispatched = sent[0];
  // Independently follow before_agent_start and task-start persistence, rather
  // than calling the benchmark projection that these regressions verify.
  const query = looksLikeGovernedBoilerplate(dispatched) ? extractTaskRequest(dispatched) : dispatched.trim();
  const persisted = boundedOperatorRequest(query, value => redactSensitiveText(value).text);
  return { ingress, dispatched, query, persisted };
}

function setJourneyRequest(f, workflow, request) {
  fs.writeFileSync(path.join(f.suiteRoot, "journey-request.md"), request);
  f.scenarios[0].userJourney = { turns: [{ id: "request", prompt: "journey-request.md", ...(workflow ? { workflow } : {}) }] };
}

test("catalog preview binds exact requests and exposes only digests/counts, never expected answers", (t) => {
  const f = fixture(t), loaded = f.load();
  assert.equal(loaded.isCurrent(), true);
  assert.equal(fs.existsSync(f.authority), false);
  assert.equal(loaded.identity.scenarios[0].requests[0].criterionCount, 1);
  for (const privateValue of ["Preserve the number.", "identity.js", "expected", f.file, f.plan.backend.dockerSocket]) {
    assert.equal(JSON.stringify(loaded.identity).includes(privateValue), false);
  }
  assert.throws(() => f.prepare(loaded, { approved: false }), /explicit/);
  assert.equal(fs.existsSync(f.authority), false);
  assert.equal(f.prepare(loaded, { surface: "codex-cli", approved: false }), null);
  assert.equal(f.prepare(loaded, { surface: "raw-pi", approved: false }), null);
  assert.equal(f.prepare(loaded, { scenarioId: "unconfigured" }).observe([]).status, "not-configured");
  assert.equal(fs.existsSync(f.authority), false);
  const prepared = f.prepare(loaded);
  assert.equal(prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, path.join(f.authority, "approval.json"));
  assert.equal(prepared.observe([]).status, "partial", "provisioned authority is not observed execution");
  assert.equal(prepared.observe([]).attempts, 0);
  assert.throws(() => f.prepare(loaded), /EEXIST/);
});

test("verification binding follows the frozen candidate while live served assets remain integrity-bound", (t) => {
  const f = fixture(t), snapshot = path.join(f.directory, "snapshot");
  fs.writeFileSync(path.join(f.installedRoot, ".gitignore"), "/packages/piagent-webui/dist/\n");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: f.installedRoot, stdio: "pipe" });
  }
  const asset = "packages/piagent-webui/dist/client/index.html", liveAsset = path.join(f.installedRoot, asset);
  fs.mkdirSync(path.dirname(liveAsset), { recursive: true }); fs.writeFileSync(liveAsset, "<p>built browser</p>\n");
  try {
    materializeBenchmarkCandidate(f.installedRoot, snapshot);
    assert.equal(fs.existsSync(path.join(snapshot, asset)), false, "Git-ignored live output is not a frozen source input");
    assert.ok(discoverRuntimeIntegrityFiles(f.installedRoot).includes(asset), "served assets must not be removed from integrity discovery");
    const live = benchmarkVerificationBinding({ installedRoot: f.installedRoot, suiteDigest: f.catalog.suiteDigest });
    const frozen = benchmarkVerificationBinding({ installedRoot: snapshot, suiteDigest: f.catalog.suiteDigest });
    assert.equal(frozen.approval, "not-granted"); assert.equal(Object.isFrozen(frozen), true);
    assert.notEqual(live.verifierDigest, frozen.verifierDigest);
    f.catalog.verifierDigest = live.verifierDigest; f.save();
    assert.throws(() => f.load({ installedRoot: snapshot }), /does not match/);
    f.catalog.verifierDigest = frozen.verifierDigest; f.save();
    const loaded = f.load({ installedRoot: snapshot });
    assert.equal(loaded.isCurrent(), true); assert.equal(fs.existsSync(f.authority), false);
    fs.appendFileSync(liveAsset, "<p>changed live asset</p>\n");
    assert.notEqual(benchmarkVerificationBinding({ installedRoot: f.installedRoot, suiteDigest: f.catalog.suiteDigest }).verifierDigest, live.verifierDigest,
      "live served-asset changes still change the live verifier identity");
    assert.equal(loaded.isCurrent(), true, "an unchanged frozen runtime does not borrow live build state");
    const frozenVerifier = path.join(snapshot, "packages/piagent-core/extensions/acceptance-durable-execution.js");
    fs.chmodSync(frozenVerifier, 0o600); // Simulate owner-level tampering with this test-owned read-only snapshot.
    fs.appendFileSync(frozenVerifier, "// changed frozen verifier\n");
    assert.equal(loaded.isCurrent(), false, "changed executed verifier still revokes the plan");
    assert.throws(() => benchmarkVerificationBinding({ installedRoot: snapshot, suiteDigest: "bad" }), /Invalid/);
  } finally { cleanupBenchmarkExecutionSnapshot(snapshot); }
});

for (const [name, mutate] of [
  ["wrong suite", f => { f.catalog.suiteDigest = "f".repeat(64); f.save(); }],
  ["wrong verifier", f => { f.catalog.verifierDigest = "f".repeat(64); f.save(); }],
  ["unlisted request", f => { f.plan.operatorRequestDigest = operatorRequestDigest("Another request."); f.save(); }],
  ["duplicate scenario", f => { f.catalog.scenarios.push(structuredClone(f.catalog.scenarios[0])); f.save(); }],
  ["duplicate request", f => { f.catalog.scenarios[0].plans.push(structuredClone(f.plan)); f.save(); }],
  ["unknown scenario", f => { f.catalog.scenarios[0].scenarioId = "unknown"; f.save(); }],
  ["public plan", f => fs.chmodSync(f.file, 0o644)],
  ["linked plan", f => fs.linkSync(f.file, path.join(f.directory, "linked.json"))],
  ["symlinked plan", f => { fs.renameSync(f.file, `${f.file}.retained`); fs.symlinkSync(`${f.file}.retained`, f.file); }]
]) test(`catalog refuses ${name} without minting authority`, (t) => {
  const f = fixture(t); mutate(f); assert.throws(() => f.load()); assert.equal(fs.existsSync(f.authority), false);
});

test("journey approval follows the actual turn prompts and detects post-preview drift", (t) => {
  const f = fixture(t);
  f.scenarios[0].userJourney = { turns: [{ id: "second", prompt: "second.md" }] };
  fs.writeFileSync(path.join(f.suiteRoot, "second.md"), "Second request.\n");
  assert.throws(() => f.load(), /not sent/);
  f.plan.operatorRequestDigest = operatorRequestDigest("Second request."); f.save();
  const loaded = f.load(), prepared = f.prepare(loaded);
  fs.appendFileSync(f.file, " ");
  assert.equal(loaded.isCurrent(), false);
  assert.equal(prepared.observe([]).status, "unavailable");
  assert.throws(() => f.prepare(loaded, { directory: path.join(f.directory, "other") }), /changed/);
});

for (const workflow of ["task", "scout", "platform-improve", "review"]) {
  test(`catalog workflow binding accepts the actual ${workflow} dispatch with multiline whitespace`, async (t) => {
    const f = fixture(t), request = "  Inspect `src/value.js`.\n\nPreserve  double spaces and\ttabs.\nRun the configured checks.\n  ";
    setJourneyRequest(f, workflow, request);
    const observed = await dispatchedJourneyRequest(workflow, request);
    assert.equal(observed.dispatched, `/${workflow} ${request.trim()}`);
    assert.equal(observed.persisted, observed.dispatched);
    f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
    assert.equal(f.load().identity.scenarios[0].requests[0].operatorRequestDigest, f.plan.operatorRequestDigest);
    assert.equal(fs.existsSync(f.authority), false);
  });

  test(`catalog workflow binding rejects raw and wrong-workflow hashes for ${workflow}`, async (t) => {
    const f = fixture(t), request = "Inspect src/value.js and report its behavior.";
    setJourneyRequest(f, workflow, request);
    const observed = await dispatchedJourneyRequest(workflow, request);
    const other = await dispatchedJourneyRequest(workflow === "task" ? "scout" : "task", request);
    for (const wrong of [request, other.persisted]) {
      assert.notEqual(operatorRequestDigest(wrong), operatorRequestDigest(observed.persisted));
      f.plan.operatorRequestDigest = operatorRequestDigest(wrong); f.save();
      assert.throws(() => f.load(), "only the actual dispatched request may bind the plan");
    }
    assert.equal(fs.existsSync(f.authority), false);
  });
}

test("catalog workflow binding keeps a simple no-workflow journey request unchanged", async (t) => {
  const f = fixture(t), request = "  Preserve the number.\n";
  setJourneyRequest(f, null, request);
  const observed = await dispatchedJourneyRequest(null, request);
  assert.equal(observed.persisted, request.trim());
  f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
  assert.doesNotThrow(() => f.load());
  assert.equal(fs.existsSync(f.authority), false);
});

for (const command of ["task", "custom"]) test(`catalog workflow binding refuses an unprojected bare /${command} command`, (t) => {
  const f = fixture(t), request = `/${command} Fix src/value.js and verify the result.`;
  setJourneyRequest(f, null, request);
  f.plan.operatorRequestDigest = operatorRequestDigest(request); f.save();
  assert.throws(() => f.load(), "a bare slash command can invoke a template or custom dispatcher before intake");
  assert.equal(fs.existsSync(f.authority), false);
});

for (const workflow of ["", "missing-workflow"]) test(`catalog workflow binding refuses ${workflow || "empty"} workflow metadata`, (t) => {
  const f = fixture(t), request = "Fix src/value.js and verify the result.";
  setJourneyRequest(f, null, request);
  f.scenarios[0].userJourney.turns[0].workflow = workflow;
  f.plan.operatorRequestDigest = operatorRequestDigest(request); f.save();
  assert.throws(() => f.load());
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding uses the generated onboarding request, not a direct-command guess", async (t) => {
  const f = fixture(t), request = "Inspect src/value.js and the repository conventions.";
  setJourneyRequest(f, "onboard", request);
  const observed = await dispatchedJourneyRequest("onboard", request);
  assert.match(observed.dispatched, /^Run the Pi Agent Platform first-read onboarding workflow/);
  assert.ok(observed.dispatched.includes(`Optional focus: ${request}`));
  assert.notEqual(observed.persisted, `/onboard ${request}`);
  f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
  assert.doesNotThrow(() => f.load());
  for (const wrong of [request, `/onboard ${request}`]) {
    f.plan.operatorRequestDigest = operatorRequestDigest(wrong); f.save();
    assert.throws(() => f.load());
  }
  assert.equal(fs.existsSync(f.authority), false);
});

for (const workflow of [null, "task"]) test(`catalog workflow binding ${workflow ? "follows explicit-workflow governed extraction" : "refuses unprojected raw governed boilerplate"}`, async (t) => {
  const f = fixture(t), inner = "Fix src/value.js.\nPreserve  spacing and verify the change.";
  const request = `Mandatory flow:\npiagent_context\npiagent_task_start\nOutput format:\nRequest:\n\`\`\`text\n${inner}\n\`\`\`\n`;
  setJourneyRequest(f, workflow, request);
  const observed = await dispatchedJourneyRequest(workflow, request);
  assert.equal(looksLikeGovernedBoilerplate(observed.dispatched), true);
  assert.equal(observed.persisted, inner);
  f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
  // Raw interactive input may be collapsed or freshened before agent-start,
  // depending on context pressure. Explicit workflow follow-ups have extension
  // origin, so the input hook preserves them and agent-start owns extraction.
  if (workflow) assert.doesNotThrow(() => f.load());
  else assert.throws(() => f.load(), "do not guess context-dependent input-hook transformations");
  f.plan.operatorRequestDigest = operatorRequestDigest(request.trim()); f.save();
  assert.throws(() => f.load());
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding uses the redacted persisted request identity", async (t) => {
  const f = fixture(t), token = `sk-proj-${"A".repeat(24)}`;
  const request = `Fix src/value.js. Synthetic test credential: ${token}.`;
  setJourneyRequest(f, "task", request);
  const observed = await dispatchedJourneyRequest("task", request);
  assert.ok(observed.query.includes(token));
  assert.ok(observed.persisted.includes("[REDACTED_SECRET]"));
  assert.equal(observed.persisted.includes(token), false);
  f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
  assert.doesNotThrow(() => f.load());
  for (const wrong of [request, observed.query]) {
    f.plan.operatorRequestDigest = operatorRequestDigest(wrong); f.save();
    assert.throws(() => f.load());
  }
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding preserves requests exactly at the Unicode persistence limit", async (t) => {
  const f = fixture(t), request = "🧩".repeat(OPERATOR_REQUEST_MAX_CHARS - "/task ".length);
  setJourneyRequest(f, "task", request);
  const observed = await dispatchedJourneyRequest("task", request);
  assert.equal(Array.from(observed.query).length, OPERATOR_REQUEST_MAX_CHARS);
  assert.ok(observed.query.length > OPERATOR_REQUEST_MAX_CHARS, "the limit is code points, not UTF-16 units");
  assert.equal(observed.persisted, observed.query);
  // This is prospective storage-bound identity, not proof that automatic task
  // admission accepts a request of this size or that a workflow has executed.
  f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
  assert.doesNotThrow(() => f.load());
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding refuses a request that cannot receive a persisted identity", async (t) => {
  const f = fixture(t), request = "x".repeat(OPERATOR_REQUEST_MAX_CHARS);
  setJourneyRequest(f, "task", request);
  const observed = await dispatchedJourneyRequest("task", request);
  assert.equal(observed.persisted, undefined, "the workflow prefix pushes the actual request over the bound");
  f.plan.operatorRequestDigest = operatorRequestDigest(request); f.save();
  assert.throws(() => f.load(), "do not authorize an undelivered raw request when persisted request identity is unavailable");
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding refuses local image paths without inspecting files", (t) => {
  const f = fixture(t), requests = [
    "Inspect /not-a-real-fixture/preview.png and fix src/value.js.",
    'Inspect "./design.webp" and fix src/value.js.',
    "Inspect file:///not-a-real-fixture/preview.jpg and fix src/value.js."
  ];
  const methods = ["readFileSync", "openSync", "statSync", "lstatSync", "existsSync", "realpathSync", "readdirSync"];
  const reads = methods.map(name => t.mock.method(fs, name, () => { throw new Error("unexpected projection filesystem read"); }));
  try {
    for (const message of requests) for (const workflow of [undefined, "task"]) {
      assert.throws(() => benchmarkVerificationRequestDigest({ message, workflow }), /Unsupported verification image request ingress/);
    }
    assert.equal(reads.reduce((count, mocked) => count + mocked.mock.callCount(), 0), 0);
  } finally { t.mock.restoreAll(); }
  setJourneyRequest(f, "task", requests[0]);
  f.plan.operatorRequestDigest = operatorRequestDigest(`/task ${requests[0]}`); f.save();
  assert.throws(() => f.load(), /Unsupported verification image request ingress/);
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding refuses raw input at the UTF-16 freshening threshold", (t) => {
  const f = fixture(t), below = "x".repeat(LONG_INPUT_CHARS - 1);
  setJourneyRequest(f, null, below);
  f.plan.operatorRequestDigest = operatorRequestDigest(below); f.save();
  assert.doesNotThrow(() => f.load(), "bounded plain prose retains its prospective identity");
  for (const request of ["x".repeat(LONG_INPUT_CHARS), "x".repeat(LONG_INPUT_CHARS + 1), "🧩".repeat(LONG_INPUT_CHARS / 2)]) {
    assert.ok(request.length >= LONG_INPUT_CHARS);
    setJourneyRequest(f, null, request);
    f.plan.operatorRequestDigest = operatorRequestDigest(request); f.save();
    assert.throws(() => f.load(), /Unsupported verification request ingress/);
  }
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding refuses different raw turns that redact to the same identity", async (t) => {
  const f = fixture(t), first = `Fix src/value.js. Synthetic credential: sk-proj-${"A".repeat(24)}.`,
    second = `Fix src/value.js. Synthetic credential: sk-proj-${"B".repeat(24)}.`;
  setJourneyRequest(f, "task", first);
  fs.writeFileSync(path.join(f.suiteRoot, "second-request.md"), second);
  f.scenarios[0].userJourney.turns.push({ id: "second", prompt: "second-request.md", workflow: "task" });
  const a = await dispatchedJourneyRequest("task", first), b = await dispatchedJourneyRequest("task", second);
  assert.notEqual(a.dispatched, b.dispatched);
  assert.equal(a.persisted, b.persisted);
  f.plan.operatorRequestDigest = operatorRequestDigest(a.persisted); f.save();
  assert.throws(() => f.load(), /Ambiguous verification request identity after normalization/);
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog workflow binding allows identical repeated turn inputs", async (t) => {
  const f = fixture(t), request = "Fix src/value.js.\nPreserve  whitespace and run the checks.";
  setJourneyRequest(f, "task", request);
  fs.writeFileSync(path.join(f.suiteRoot, "repeat-request.md"), request);
  f.scenarios[0].userJourney.turns.push({ id: "repeat", prompt: "repeat-request.md", workflow: "task" });
  const observed = await dispatchedJourneyRequest("task", request);
  f.plan.operatorRequestDigest = operatorRequestDigest(observed.persisted); f.save();
  const loaded = f.load();
  assert.equal(loaded.identity.scenarios[0].requests.length, 1, "repeated identical input does not create a second authority identity");
  assert.equal(loaded.identity.scenarios[0].requests[0].operatorRequestDigest, f.plan.operatorRequestDigest);
  assert.equal(fs.existsSync(f.authority), false);
});

test("catalog schema and semantic validation agree, including nested plan constraints", (t) => {
  const f = fixture(t), validate = createRootSchemaRegistry(root).get("benchmark-independent-verification-plan");
  assert.equal(validate(f.catalog), true, JSON.stringify(validate.errors));
  assert.equal(validateBenchmarkVerificationPlan(f.catalog), f.catalog);
  f.plan.backend.imageId = "worker:latest";
  assert.equal(validate(f.catalog), false); assert.throws(() => validateBenchmarkVerificationPlan(f.catalog));
});

test("verification approval is separate from cost confirmation and appears explicitly in resume instructions", () => {
  const options = parseBenchmarkArgs(["--verification-plan", "/private/plan.json", "--yes"]);
  assert.equal(options.approveVerification, false);
  assert.equal(parseBenchmarkArgs(["--verification-plan", "/private/plan.json", "--approve-verification"]).approveVerification, true);
  assert.throws(() => parseBenchmarkArgs(["--approve-verification", "--approve-verification"]));
  assert.match(benchmarkResumeCommand({ runRoot: "/private/run", verificationRequired: true }), /--approve-verification --yes$/);
  assert.doesNotMatch(benchmarkResumeCommand({ runRoot: "/private/run" }), /approve-verification/);
});

test("two exact requests use independent runtime contracts and retain actual pass/fail executions", { skip: !imageId || !dockerSocket, timeout: 60000 }, async (t) => {
  const f = fixture(t), second = structuredClone(f.plan);
  fs.writeFileSync(path.join(f.suiteRoot, "second.md"), "Return two instead.\n");
  f.scenarios[0].userJourney = { turns: [{ id: "first", prompt: "prompt.md" }, { id: "second", prompt: "second.md" }] };
  second.operatorRequestDigest = operatorRequestDigest("Return two instead.");
  second.contracts[0].criterionHash = "f".repeat(64); second.contracts[0].checks[0].cases[0].expected.value.value = 2;
  f.catalog.scenarios[0].plans.push(second); f.save();
  fs.writeFileSync(path.join(f.projectRoot, "identity.js"), "export const identity = x => x;\n");
  for (const args of [["init", "-q"], ["add", "identity.js"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) {
    execFileSync("git", args, { cwd: f.projectRoot, stdio: "pipe" });
  }
  const prepared = f.prepare(), config = openHostContractConfiguration({ configPath: prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG,
    projectRoot: f.projectRoot, installedRoot: f.installedRoot });
  t.after(() => config.close());
  const tasks = [];
  let active;
  const sessionId = "two-request-session", ctx = { cwd: f.projectRoot, sessionManager: { getSessionId: () => sessionId } };
  // Unit-level host project-verifier state; worker execution and durable
  // request selection are real. Actual project tool hooks have separate E2E coverage.
  const runtime = new IndependentAcceptanceRuntime({ state: { projectVerification: { currentDigest: () => "a".repeat(64) } },
    installedRoot: f.installedRoot, configPath: prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG,
    activeTask: () => active, authorizeSourceRead: () => true });
  await runtime.activate(ctx); t.after(() => runtime.clear(ctx));
  let priorPreparation;
  for (const [index, plan] of f.catalog.scenarios[0].plans.entries()) {
    const approved = config.forRequest(plan.operatorRequestDigest), contract = approved.contracts[0];
    const task = { taskRunId: `request-${index}`, sessionId, trace: { outcome: "pending" }, operatorRequestDigest: plan.operatorRequestDigest,
      acceptanceReceipt: { criteria: [{ id: contract.criterionId, hash: contract.criterionHash }] } };
    tasks.push(task); active = task;
    if (priorPreparation) assert.equal(priorPreparation.isCurrent(), false);
    priorPreparation = await runtime.prepare(ctx, task);
    const event = config.store.latest({ taskRunId: task.taskRunId, criterionId: contract.criterionId });
    assert.equal(event?.phase, "settled");
    const result = JSON.parse(event.evidenceText);
    assert.equal(result.verdict, index === 0 ? "pass" : "fail", JSON.stringify(result));
    if (index === 0) assert.equal(prepared.observe(tasks).status, "partial", "first request cannot cover the second");
  }
  const observation = prepared.observe(tasks);
  assert.equal(observation.status, "observed", JSON.stringify(observation));
  assert.equal(observation.attempts, 2); assert.equal(observation.workersObserved, 2);
  assert.equal(validBenchmarkVerificationObservation(observation), true);
  const identity = f.load().identity, record = { surface: "piagent", scenarioId: "identity", resolved: false, independentVerification: observation };
  assert.equal(benchmarkVerificationRecordMatches(record, identity), true);
  assert.equal(benchmarkVerificationRecordMatches({ ...record, resolved: true }, identity), false, "an observed failure cannot be scored as resolution");
  for (const mutate of [value => { value.attempts += 1; }, value => { value.workersObserved += 1; },
    value => { value.requests[0].runs[0].criteria[0].criterionHash = "0".repeat(64); },
    value => { value.requests.splice(1, 1); }, value => { value.requests[0].runs[0].criteria[0].workerObserved = false; }]) {
    const changed = structuredClone(observation); mutate(changed);
    assert.equal(benchmarkVerificationRecordMatches({ ...record, independentVerification: changed }, identity), false);
  }
  assert.equal(benchmarkVerificationRecordMatches({ ...record, independentVerification: prepared.observe([]), resolved: true }, identity), false);
  assert.equal(benchmarkVerificationRecordMatches({ ...record, independentVerification: undefined }, identity), false);
  assert.equal(benchmarkVerificationRecordMatches({ ...record, surface: "codex-cli" }, identity), false);
  assert.deepEqual(observation.requests.map(entry => entry.runs[0].criteria[0].verdict), ["pass", "fail"]);
  assert.equal(Object.hasOwn(observation, "completionAllowed"), false, "measurement is not completion authority");
  assert.equal(prepared.observe([tasks[0], tasks[0]]).status, "unavailable", "duplicate task IDs cannot inflate measured attempts");
  assert.equal(prepared.observe(tasks.map(task => ({ ...task, taskRunId: `foreign-${task.taskRunId}` }))).status, "partial");
  active = { ...tasks[0], taskRunId: "unapproved", operatorRequestDigest: operatorRequestDigest("Not approved.") };
  await runtime.prepare(ctx, active);
  assert.equal(config.store.latest({ taskRunId: active.taskRunId, criterionId: f.plan.contracts[0].criterionId }), null);
  active = { ...tasks[0], taskRunId: "wrong-criterion", acceptanceReceipt: tasks[1].acceptanceReceipt };
  await runtime.prepare(ctx, active);
  assert.equal(config.store.latest({ taskRunId: active.taskRunId, criterionId: f.plan.contracts[0].criterionId }), null);
});
