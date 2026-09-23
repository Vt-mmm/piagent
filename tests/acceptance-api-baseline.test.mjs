import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { apiBaselineCriterionEvidence, compareSupportedPublicApi } from "../packages/piagent-core/runtime/verification/acceptance-api-baseline.js";
import { apiBaselineCriterionEvidence as dispatchApiBaselineEvidence, apiBaselineRecoveryProjection } from "../packages/piagent-core/extensions/acceptance-api-baseline.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt, acceptanceCriticalRecoveryProjection } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { genericCriterionEvidence } from "../packages/piagent-core/extensions/acceptance-behavior-proof.js";
import { changedFileAcceptanceCorpus } from "../packages/piagent-core/extensions/acceptance-language-adapters.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";
import { captureTaskBaselineManifest, taskBaselineManifestPath } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = "src/frontend/pagination.js", testPath = "test/api.test.js";
const criterionText = "Keep the API and verify the project.";
const behaviorCriteria = [
  "`pageCount(totalItems, pageSize)` must use exact ceiling division, return zero for zero items, and throw `TypeError` unless total items is a non-negative integer and page size is a positive integer.",
  "`clampPage` returns zero when no pages exist; otherwise it clamps an integer page to the inclusive range `1..pageCount`."
];
const baseline = fs.readFileSync(path.join(repositoryRoot, "benchmarks/production-v3/project", sourcePath), "utf8");
const [, reference] = productionV3ReferenceSolution("pagination-boundary");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const initializerPermission = "Changing the formal default initializer to satisfy this distinction is permitted;";
const clockBaseline = "export function expired(value, now = Date.now()) { return now >= value; }";
const clockCurrent = "export function expired(value, now = undefined) { return now >= value; }";
for (const [label, mode, current, allowed] of [
  ["bound permission", "bound", clockCurrent, true],
  ["criteria alone cannot grant permission", "unrequested", clockCurrent, false],
  ["stale request digest", "stale", clockCurrent, false],
  ["example text cannot grant permission", "example", clockCurrent, false],
  ["parameter addition remains forbidden", "bound", clockCurrent.replace("now = undefined)", "now = undefined, extra)"), false],
  ["default position remains exact", "bound", clockCurrent.replace("value, now = undefined", "value = 0, now = undefined"), false],
  ["return representation remains exact", "bound", clockCurrent.replace("now >= value", "1"), false]
]) test(`requested default initializer: ${label}`, async t => {
  const change = `Fix \`expired(value, now)\` in \`${sourcePath}\`.`;
  const { input } = await fixture(t, { committedSource: clockBaseline, currentSource: current,
    behaviorCriteria: [change, initializerPermission] });
  input.task.operatorRequest = `${change}\n${mode === "example" ? "Example text: " : ""}${mode === "unrequested" ? "Keep the default initializer unchanged." : initializerPermission}`;
  input.task.operatorRequestDigest = operatorRequestDigest(input.task.operatorRequest);
  if (mode === "stale") input.task.operatorRequest += "\nLater correction.";
  const result = apiBaselineCriterionEvidence(input);
  assert.equal(Boolean(result.evidence), allowed, result.reason);
  assert.equal(input.criterion.status, "pending", "API evidence must not complete the task itself");
});

test("undefined defaults remain exact and cannot use a shadowed binding", () => {
  assert.equal(compareSupportedPublicApi(clockCurrent, clockCurrent).compatible, true);
  assert.equal(compareSupportedPublicApi(clockBaseline, clockCurrent).compatible, false);
  for (const source of [clockCurrent.replace("value, now", "undefined, now"),
    "function undefined() { return 0; }\n" + clockCurrent,
    clockCurrent.replace("return now", "const undefined = 1; return now")]) {
    assert.equal(compareSupportedPublicApi(clockCurrent, source).compatible, null);
  }
});

async function fixture(t, options = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-api-baseline-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src/frontend"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(cwd, sourcePath), options.committedSource ?? baseline);
  git(cwd, "init", "-q"); git(cwd, "config", "user.email", "fixture@example.invalid"); git(cwd, "config", "user.name", "Offline fixture");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "task baseline");
  if (options.dirtyBaseline) fs.writeFileSync(path.join(cwd, sourcePath), options.dirtyBaseline);
  for (const [file, content] of Object.entries(options.baselineFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  }
  const createdAt = options.createdAt ?? new Date().toISOString();
  const clause = options.criterionText ?? criterionText;
  const built = buildAcceptanceReceipt({ summary: clause, expectedOutput: clause,
    acceptanceCriteria: [clause, ...(options.behaviorCriteria ?? behaviorCriteria)], changeMode: "source-change", source: "runtime", generatedAt: createdAt });
  const task = { taskId: "api-task", taskRunId: "api-task-run", sessionId: "api-session", createdAt,
    summary: clause, expectedOutput: clause, acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt, changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
    scope: [sourcePath, "test/**"], protectedPaths: [], outOfScope: [],
    baselineFileDigests: workingTreeSnapshot(cwd), verifyCommands: [`node --test ${testPath}`], verifyEvidence: [] };
  task.baselineChangedFiles = Object.keys(task.baselineFileDigests).sort();
  const manifest = await captureTaskBaselineManifest({ projectRoot: cwd, taskId: task.taskId,
    taskRunId: task.taskRunId, sessionId: task.sessionId, capturedAt: createdAt,
    baselineTreeDigest: workingTreeEvidenceDigest(task.baselineFileDigests),
    isProtectedProjectPath: file => (options.protectedBaselineFiles ?? []).includes(file),
    maxEntries: options.maxBaselineEntries, maxFileBytes: options.maxBaselineFileBytes });
  fs.writeFileSync(path.join(cwd, sourcePath), options.currentSource ?? reference);
  // A real but intentionally minimal verifier: API comparison must independently
  // catch incompatible declarations even when this module-load test passes.
  fs.writeFileSync(path.join(cwd, testPath), "import test from 'node:test'; import assert from 'node:assert/strict'; "
    + "import * as api from '../src/frontend/pagination.js'; test('module loads', () => assert.equal(typeof api, 'object'));\n");
  const refresh = () => {
    const before = captureWorkspaceVerificationSnapshot(cwd), env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", testPath], { cwd, env, encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const after = captureWorkspaceVerificationSnapshot(cwd);
    assert.equal(before.digest, after.digest); assert.equal(before.workspaceRevisionDigest, after.workspaceRevisionDigest);
    task.verifyEvidence = [{ command: task.verifyCommands[0], exitCode: 0, observed: true, matchedProfileCommand: true,
      recordedAt: new Date().toISOString(), preWorkingTreeDigest: before.digest, workingTreeDigest: after.digest,
      preWorkspaceRevisionDigest: before.workspaceRevisionDigest, workspaceRevisionDigest: after.workspaceRevisionDigest }];
    task.changedFiles = [sourcePath, testPath];
    return { cwd, task, criterion: task.acceptanceReceipt.criteria[0],
      apiBaselineEvidence: apiBaselineCriterionEvidence,
      corpus: changedFileAcceptanceCorpus(cwd, task.changedFiles), currentWorkingTreeDigest: after.digest,
      workspaceRevisionDigest: after.workspaceRevisionDigest, recordedAt: new Date().toISOString() };
  };
  return { cwd, task, manifest, refresh, input: refresh() };
}

test("AC07 keeps its exact text and receives baseline-backed API evidence after real verification", async t => {
  const { input } = await fixture(t);
  assert.equal(input.task.acceptanceCriteria[0], criterionText);
  assert.equal(input.criterion.hash, "aeaf8a92672dd981f1a25d3cd863d317f17fbdc53bebd640c1b5167bab301d10");
  const old = genericCriterionEvidence({ ...input, criterion: { ...input.criterion, priority: "critical" },
    obligation: "backward-compatibility", taskText: criterionText, passingVerifier: true,
    verifierEvidence: { kind: "verify-command" } });
  assert.equal(old.evidence, undefined, "the old generic branch has no API-baseline proof");
  const result = apiBaselineCriterionEvidence(input);
  assert.ok(result.evidence, result.reason);
  assert.equal(result.evidence.workingTreeDigest, input.currentWorkingTreeDigest);
  assert.equal(result.evidence.kind, "task-baseline-public-api");
  assert.match(result.evidence.summary, /Behavioral equivalence is not inferred/);
  assert.equal(input.task.acceptanceReceipt.criteria[0].status, "pending", "the module supplies evidence, never completion authority");
});

test("core receipt and advisory paths require the injected runtime baseline reader", async t => {
  const { input } = await fixture(t);
  const withoutReader = { ...input, apiBaselineEvidence: undefined };
  assert.deepEqual(dispatchApiBaselineEvidence(withoutReader), { handled: true, reason: "api-baseline-reader-unavailable" });
  const pending = refreshAcceptanceReceipt(input.task, withoutReader).receipt.criteria[0];
  assert.equal(pending.status, "pending");
  assert.equal(acceptanceCriticalRecoveryProjection(input.task, withoutReader).find(item => item.criterionId === input.criterion.id)?.missingDimensions[0], "api-baseline-reader-unavailable");
  const supported = refreshAcceptanceReceipt(input.task, input).receipt.criteria[0];
  assert.equal(supported.status, "satisfied");
  assert.ok(supported.evidence.some(item => item.kind === "task-baseline-public-api"));
  assert.equal(acceptanceCriticalRecoveryProjection(input.task, input).some(item => item.criterionId === input.criterion.id), false);
});

for (const [name, source] of [
  ["removed export", reference.slice(0, reference.indexOf("export function clampPage"))],
  ["renamed export", reference.replaceAll("pageCount", "countPages")],
  ["reordered parameters", reference.replace("pageCount(totalItems, pageSize)", "pageCount(pageSize, totalItems)")],
  ["changed arity", reference.replace("pageCount(totalItems, pageSize)", "pageCount(totalItems, pageSize, options)")],
  ["changed default", reference.replace("pageCount(totalItems, pageSize)", "pageCount(totalItems, pageSize = 5)")],
  ["changed rest parameter", reference.replace("pageCount(totalItems, pageSize)", "pageCount(totalItems, ...pageSize)")],
  ["async callable", reference.replace("export function pageCount", "export async function pageCount")],
  ["generator callable", reference.replace("export function pageCount", "export function* pageCount")],
  ["default instead of named export", reference.replace("export function pageCount", "export default function pageCount")],
  ["number to object", reference.replace("return Math.ceil(totalItems / pageSize);", "return { count: Math.ceil(totalItems / pageSize) };")],
  ["function to value", reference.slice(0, reference.indexOf("export function clampPage")) + "export const clampPage = 1;"],
  ["reassigned owned callable", reference + "pageCount = () => 1;"],
  ["shadowed result intrinsic", reference.replace("pageCount(totalItems, pageSize)", "pageCount(totalItems, pageSize, Math)")]
]) test(`same current verifier cannot authorize ${name}`, async t => {
  const { input } = await fixture(t, { currentSource: source });
  const result = apiBaselineCriterionEvidence(input);
  assert.equal(result.evidence, undefined);
  assert.match(result.reason, /^api-contract-(?:changed|unsupported)$/);
});

test("dirty task-start bytes, not committed bytes, determine the baseline API", async t => {
  const renamed = baseline.replaceAll("pageCount", "previousCount");
  const positive = await fixture(t, { committedSource: renamed, dirtyBaseline: baseline });
  assert.ok(apiBaselineCriterionEvidence(positive.input).evidence);
  const negative = await fixture(t, { dirtyBaseline: baseline + "\nexport function apiVersion() { return 1; }\n" });
  assert.equal(apiBaselineCriterionEvidence(negative.input).reason, "api-contract-changed");
});

test("advancing current HEAD cannot replace the captured baseline", async t => {
  const { cwd, refresh } = await fixture(t, { currentSource: reference.replaceAll("pageCount", "countPages") });
  git(cwd, "add", sourcePath); git(cwd, "commit", "-qm", "changed API after task start");
  assert.equal(apiBaselineCriterionEvidence(refresh()).reason, "api-contract-changed");
});

test("missing, tampered and expired baselines provide reasons, never evidence", async t => {
  const missing = await fixture(t);
  fs.renameSync(taskBaselineManifestPath(missing.cwd, missing.task.taskRunId), path.join(missing.cwd, "baseline-backup.json"));
  assert.equal(apiBaselineCriterionEvidence(missing.refresh()).reason, "api-baseline-unavailable");
  const diagnostic = apiBaselineRecoveryProjection({ ...missing.refresh(), criterionText });
  assert.deepEqual(diagnostic.projection.missingDimensions, ["api-baseline-unavailable"]);
  assert.match(diagnostic.projection.proofHints[0], /not an observed source defect/);
  const tampered = await fixture(t);
  const manifestPath = taskBaselineManifestPath(tampered.cwd, tampered.task.taskRunId);
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")); raw.roots[0].headOid = "a".repeat(40);
  fs.writeFileSync(manifestPath, JSON.stringify(raw));
  assert.equal(apiBaselineCriterionEvidence(tampered.input).reason, "api-baseline-unavailable");
  const expired = await fixture(t, { createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(apiBaselineCriterionEvidence(expired.input).reason, "api-baseline-expired");
});

test("task, session and baseline digest identity must remain exact", async t => {
  const { input } = await fixture(t);
  for (const change of [{ sessionId: "another-session" }, { taskId: "another-task" },
    { createdAt: new Date(Date.parse(input.task.createdAt) - 1000).toISOString() },
    { baselineFileDigests: { other: input.currentWorkingTreeDigest } }]) {
    assert.equal(apiBaselineCriterionEvidence({ ...input, task: { ...input.task, ...change } }).reason, "api-baseline-binding-mismatch");
  }
  const wrongCriterion = { ...input.criterion, hash: "a".repeat(64) };
  assert.equal(apiBaselineCriterionEvidence({ ...input, criterion: wrongCriterion }).reason, "api-criterion-binding-mismatch");
});

test("the verification conjunct, current tree and exact source scope remain mandatory", async t => {
  const { input, cwd } = await fixture(t);
  assert.equal(apiBaselineCriterionEvidence({ ...input, task: { ...input.task, verifyEvidence: [] } }).reason, "api-current-verifier-missing");
  assert.equal(apiBaselineCriterionEvidence({ ...input, task: { ...input.task, verifyCommands: [...input.task.verifyCommands, "node --check src/frontend/pagination.js"] } }).reason, "api-current-verifier-missing");
  assert.equal(apiBaselineCriterionEvidence({ ...input, task: { ...input.task, scope: ["test/**"] } }).reason, "api-source-scope-unavailable");
  assert.equal(apiBaselineCriterionEvidence({ ...input, task: { ...input.task, protectedPaths: [sourcePath] } }).reason, "api-source-scope-unavailable");
  const corpus = { ...input.corpus, sourceEntries: [{ ...input.corpus.sourceEntries[0], text: baseline }] };
  assert.equal(apiBaselineCriterionEvidence({ ...input, corpus }).reason, "api-source-corpus-mismatch");
  fs.appendFileSync(path.join(cwd, sourcePath), "\n// changed after verification\n");
  assert.equal(apiBaselineCriterionEvidence(input).reason, "api-current-tree-mismatch");
});

test("supported API comparison does not pretend to prove semantic equivalence", () => {
  const wrongBehavior = reference.replace("Math.ceil(totalItems / pageSize)", "999");
  assert.equal(compareSupportedPublicApi(reference, wrongBehavior).compatible, true,
    "same supported API is not proof that requested calculation behavior is correct");
  assert.equal(compareSupportedPublicApi(reference, reference + " ".repeat(64_001)).reason, "api-proof-limit");
  const reexport = "function pageCount(totalItems, pageSize) { return 1; } export { pageCount } from './other.js';";
  assert.equal(compareSupportedPublicApi(reference, reexport).compatible, null);
});

test("unrelated public bodies and their local dependency closures cannot borrow targeted behavior", async t => {
  const unchanged = "\nexport function answer() { return 1; }\n";
  const positive = await fixture(t, { committedSource: baseline + unchanged, currentSource: reference + unchanged });
  assert.ok(apiBaselineCriterionEvidence(positive.input).evidence);
  const changed = await fixture(t, { committedSource: baseline + unchanged,
    currentSource: reference + unchanged.replace("return 1", "return 2") });
  assert.equal(apiBaselineCriterionEvidence(changed.input).reason, "api-unrelated-implementation-changed");
  const dependency = "\nfunction localAnswer() { return 1; }\nexport function answer() { return localAnswer(); }\n";
  const indirect = await fixture(t, { committedSource: baseline + dependency,
    currentSource: reference + dependency.replace("return 1", "return 2") });
  assert.equal(apiBaselineCriterionEvidence(indirect.input).reason, "api-unrelated-implementation-changed");
});

test("targeted behavior must be an exact bound sibling subject in the owning module", async t => {
  const noSibling = await fixture(t, { behaviorCriteria: [] });
  assert.equal(apiBaselineCriterionEvidence(noSibling.input).reason, "api-unrelated-implementation-changed");
  const unrelated = "\nexport function answer() { return 1; }\n";
  for (const clause of ["`pageCount` must return the value of `answer`.",
    "`answer` must return 2 in `src/other.js`."]) {
    const invalid = await fixture(t, { committedSource: baseline + unrelated,
      currentSource: reference + unrelated.replace("return 1", "return 2"),
      behaviorCriteria: [...behaviorCriteria, clause] });
    assert.equal(apiBaselineCriterionEvidence(invalid.input).reason, "api-unrelated-implementation-changed");
  }
});

test("additional semantic constraints are not swallowed by the closed API clause", async t => {
  const { input } = await fixture(t);
  const text = "Keep the API and preserve every previous output and verify the project.";
  const built = buildAcceptanceReceipt({ summary: text, expectedOutput: text, acceptanceCriteria: [text],
    changeMode: "source-change", source: "runtime", generatedAt: input.task.createdAt });
  assert.deepEqual(apiBaselineCriterionEvidence({ ...input, task: { ...input.task, acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt }, criterion: built.receipt.criteria[0] }), { handled: false });
});

for (const clause of ["Do not change the exported API.", "Keep the exported API and verify the project."]) {
  test(`explicit exported API clause uses the same captured baseline: ${clause}`, async t => {
    const positive = await fixture(t, { criterionText: clause });
    const accepted = apiBaselineCriterionEvidence(positive.input);
    assert.equal(accepted.handled, true);
    assert.ok(accepted.evidence, accepted.reason);
    assert.equal(accepted.evidence.kind, "task-baseline-public-api");
    const negative = await fixture(t, { criterionText: clause,
      currentSource: reference.replace("pageCount(totalItems, pageSize)", "pageCount(totalItems, pageSize, options)") });
    const rejected = apiBaselineCriterionEvidence(negative.input);
    assert.equal(rejected.evidence, undefined);
    assert.equal(rejected.reason, "api-contract-changed");
  });
}

const localArraySource = 'export function rows(events) { const out = []; for (const event of events) { out.push(event); } return out.map(item => item); }';
const booleanBaseline = 'export function isReady(value, current) { return false; }';
const booleanHelpers = 'function timestamp(value) { const clock = new Date(0); clock.setUTCFullYear(value); return clock.getTime(); }\n'
  + 'export function isReady(value, current) { const instant = timestamp(value); return current >= instant; }';
for (const [label, current, compatible] of [
  ['owned Date helper and comparison', booleanHelpers, true],
  ['intrinsic Date getter', booleanHelpers.replace('const clock = new Date(0); clock.setUTCFullYear(value); return clock.getTime();', 'return Date.prototype.getTime.call(value);'), true],
  ['literal boolean with a closed helper call', booleanHelpers.replace('return current >= instant;', 'return true;'), true],
  ['changed arity', booleanHelpers.replace('isReady(value, current)', 'isReady(value, current, options)'), false],
  ['changed public name', booleanHelpers.replace('isReady(value, current)', 'different(value, current)'), false],
  ['non-boolean result', booleanHelpers.replace('return current >= instant;', 'return 1;'), null],
  ['mixed normal returns', booleanHelpers.replace('return current >= instant;', 'if (current) return true; return {};'), null],
  ['normal fallthrough', booleanHelpers.replace('return current >= instant;', 'if (current) return true;'), null],
  ['escaping function binding', booleanHelpers.replace('return clock.getTime();', 'return isReady;'), null],
  ['rebound public function', booleanHelpers.replace('return clock.getTime();', 'isReady = () => []; return 0;'), null],
  ['shadowed Date binding', booleanHelpers.replace('timestamp(value)', 'timestamp(Date)'), null],
  ['computed intrinsic member', booleanHelpers.replace('clock.getTime()', "clock['getTime']()"), null],
  ['unknown helper method', booleanHelpers.replace('clock.getTime()', 'clock.evaluate()'), null],
  ['reflective constructor', booleanHelpers.replace('clock.getTime()', "clock.constructor.constructor('return 0')()"), null],
  ['nested callable scope', booleanHelpers.replace('return clock.getTime();', 'const read = () => clock.getTime(); return read();'), null]
]) test(`closed boolean API representation: ${label}`, () => {
  assert.equal(compareSupportedPublicApi(booleanBaseline, current).compatible, compatible);
});
for (const clause of [
  'Preserve the API and verify the project.',
  'Preserve the exported API.',
  'Preserve the public API unchanged and run the configured verification.'
]) for (const changed of [false, true]) {
  test(`exact API intent overrides inferred boundary evidence: ${clause} / ${changed ? 'changed arity' : 'compatible'}`, async t => {
    const context = await fixture(t, { criterionText: clause,
      currentSource: changed ? reference.replace('pageCount(totalItems, pageSize)', 'pageCount(totalItems, pageSize, options)') : reference });
    fs.writeFileSync(path.join(context.cwd, testPath), "import test from 'node:test'; import assert from 'node:assert/strict'; "
      + "import { pageCount } from '../src/frontend/pagination.js'; test('zero and inclusive ceiling edge', () => { "
      + "assert.equal(pageCount(0, 5), 0); assert.equal(pageCount(11, 5), 3); });\n");
    const input = context.refresh();
    assert.equal(input.criterion.obligation, 'boundary-case', 'preserve retains the existing inferred category and criterion identity');
    const direct = apiBaselineCriterionEvidence(input);
    const current = refreshAcceptanceReceipt(input.task, input);
    assert.equal(current.receipt.criteria[0].status, changed ? 'pending' : 'satisfied');
    if (changed) assert.equal(direct.reason, 'api-contract-changed');
    else {
      assert.equal(direct.evidence?.kind, 'task-baseline-public-api');
      assert.deepEqual(current.receipt.criteria[0].evidence.map(item => item.kind), ['task-baseline-public-api']);
    }
    const projection = acceptanceCriticalRecoveryProjection(input.task, input).find(item => item.criterionId === input.criterion.id);
    if (changed) assert.deepEqual(projection?.missingDimensions, ['api-contract-changed']);
    else assert.equal(projection, undefined);
    const resumedTask = { ...input.task, acceptanceReceipt: current.receipt };
    const missingReader = { ...input, apiBaselineEvidence: undefined };
    assert.equal(refreshAcceptanceReceipt(resumedTask, missingReader).receipt.criteria[0].status, 'pending',
      'a prior satisfied receipt and passing boundary tests cannot replace the baseline reader');
    assert.deepEqual(acceptanceCriticalRecoveryProjection(resumedTask, missingReader)
      .find(item => item.criterionId === input.criterion.id)?.missingDimensions, ['api-baseline-reader-unavailable']);
  });
}
for (const [label, current, compatible] of [
  ['unchanged local array', localArraySource, true],
  ['literal array', 'export function rows(events) { return [events]; }', true],
  ['Map return is not an array', 'export function rows(events) { const out = new Map(); return out; }', null],
  ['changed array content is not semantic equivalence', localArraySource.replace('out.push(event)', 'out.push(1)'), true],
  ['changed arity', localArraySource.replace('rows(events)', 'rows(events, extra)'), false],
  ['renamed export', localArraySource.replace('rows(events)', 'other(events)'), false],
  ['primitive return', localArraySource.replace('return out.map(item => item);', 'return 1;'), false],
  ['object return', localArraySource.replace('return out.map(item => item);', 'return { rows: out };'), null],
  ['parameter receiver', 'export function rows(events) { return events.map(item => item); }', null],
  ['overwritten method', localArraySource.replace('return out.map', 'out.map = () => 1; return out.map'), null],
  ['shadowed arrow binding', localArraySource.replace('out.map(item => item)', 'out.map(out => out.sort())'), null],
  ['additional callable scope', localArraySource.replace('out.map(item => item)', 'out.map(function(out) { return out.sort(); })'), null],
  ['shadowed loop binding', localArraySource.replace('const event of events', 'const out of events'), null],
  ['additional return representation', localArraySource.replace('const out = [];', 'if (!events) return 1; const out = [];'), null],
  ['loop early return', localArraySource.replace('out.push(event);', 'return [event];'), null],
  ['unknown call', localArraySource.replace('out.push(event);', 'events.mutate(out);'), null],
  ['shadowed intrinsic', localArraySource.replace('const out = [];', 'const Map = events; const out = [];'), null],
  ['computed method', localArraySource.replace('out.map(item => item)', "out['map'](item => item)"), null],
  ['escaped alias receiver', localArraySource.replace('return out.map(item => item);', 'const alias = out; return alias.map(item => item);'), null]
]) test(`closed local-array API comparison: ${label}`, () => {
  assert.equal(compareSupportedPublicApi(localArraySource, current).compatible, compatible);
});

test('array API evidence keeps an explicit repair target bound to its source and other public bodies', async t => {
  const [file, currentSource] = productionV3ReferenceSolution('stable-dedup');
  const committedSource = fs.readFileSync(path.join(repositoryRoot, 'benchmarks/production-v3/project', file), 'utf8');
  const behaviorCriteria = [`Fix \`deduplicateEvents(events)\` in \`${sourcePath}\`.`, 'Return one event per id.'];
  const options = { committedSource, currentSource, behaviorCriteria, criterionText: 'Keep the exported API and verify the project.' };
  const positive = await fixture(t, options);
  assert.ok(apiBaselineCriterionEvidence(positive.input).evidence);
  const additional = '\nexport function apiVersion() { return 1; }\n';
  const unrelated = await fixture(t, { ...options, committedSource: committedSource + additional,
    currentSource: currentSource + additional.replace('return 1', 'return 2') });
  assert.equal(apiBaselineCriterionEvidence(unrelated.input).reason, 'api-unrelated-implementation-changed');
  const changed = await fixture(t, { ...options, currentSource: currentSource.replace('deduplicateEvents(events)', 'deduplicateEvents(events, extra)') });
  assert.equal(apiBaselineCriterionEvidence(changed.input).reason, 'api-contract-changed');
});

for (const clause of ['Fix `deduplicateEvents(events)` in `src/other.js`.',
  `Compare \`deduplicateEvents(events)\` in \`${sourcePath}\`.`,
  `Fix \`deduplicateEvents(events)\` in \`${sourcePath}\`. For example, not as the actual target.`,
  'Fix `deduplicateEvents(events)` in `notes.md`.']) {
  test(`explicit repair target rejects foreign or ambiguous scope: ${clause}`, async t => {
    const [file, currentSource] = productionV3ReferenceSolution('stable-dedup');
    const committedSource = fs.readFileSync(path.join(repositoryRoot, 'benchmarks/production-v3/project', file), 'utf8');
    const { input } = await fixture(t, { committedSource, currentSource,
      criterionText: 'Keep the exported API and verify the project.', behaviorCriteria: [clause] });
    assert.equal(apiBaselineCriterionEvidence(input).reason, 'api-unrelated-implementation-changed');
  });
}

for (const [label, source] of [
  ['separate branch constants', 'export function f(x) { if (x) { const value = 1; return value; } else { const value = 2; return value; } }'],
  ['unused arrays in separate scopes', 'export function f(x) { if (x) { const values = []; return 1; } else { const values = []; return 2; } }'],
  ['unused Date parameter with boolean result', 'export function f(Date) { return false; }'],
  ['Date parameter compared without Date intrinsics', 'export function f(Date) { return Date >= 0; }'],
  ['primitive Map parameter', 'export function f(Map) { return 1; }'],
  ['primitive intrinsic conversion of a callback', 'export function f(x) { return Math.min(function() { return 1; }); }']
]) test(`local-array support preserves the existing primitive grammar: ${label}`, () => {
  assert.equal(compareSupportedPublicApi(source, source).compatible, true);
});

for (const dirty of [false, true]) test(`unrelated protected baseline entries preserve ${dirty ? 'dirty captured' : 'clean HEAD'} API source`, async t => {
  const { input, manifest } = await fixture(t, { baselineFiles: { 'private/config.json': '{}' },
    protectedBaselineFiles: ['private/config.json'], ...(dirty ? { dirtyBaseline: baseline + '\n' } : {}) });
  assert.equal(manifest.captureState, 'unavailable');
  assert.equal(manifest.reasonCode, 'protected-path');
  assert.equal(manifest.roots[0].entries.find(entry => entry.state === 'protected').contentRef, null);
  assert.equal(apiBaselineCriterionEvidence(input).evidence?.kind, 'task-baseline-public-api');
});
for (const [label, options] of [
  ['protected target', { dirtyBaseline: baseline + '\n', protectedBaselineFiles: [sourcePath] }],
  ['truncated inventory', { baselineFiles: { 'private/config.json': '{}', 'zzz.txt': 'other' }, protectedBaselineFiles: ['private/config.json'], maxBaselineEntries: 1 }],
  ['oversized entry following protected entry', { baselineFiles: { 'private/config.json': '{}', 'zzz.txt': 'x'.repeat(2048) }, protectedBaselineFiles: ['private/config.json'], maxBaselineFileBytes: 1024 }]
]) test(`protected baseline exceptions do not authorize ${label}`, async t => {
  const { input, manifest } = await fixture(t, options);
  assert.equal(manifest.captureState, 'unavailable');
  assert.equal(apiBaselineCriterionEvidence(input).evidence, undefined);
  assert.equal(apiBaselineCriterionEvidence(input).reason, 'api-baseline-unavailable');
});

{
const compare = compareSupportedPublicApi;
const source='export function total(value, rate = 0) { return Math.round(value * (1 + rate)); }';
for (const [label, current, compatible] of [
 ['unchanged default',source,true],
 ['changed default',source.replace('rate = 0','rate = 1'),false],
 ['removed default',source.replace('rate = 0','rate'),false],
 ['reordered parameter',source.replace('value, rate = 0','rate, value = 0'),false],
 ['extra parameter',source.replace('rate = 0','rate = 0, options'),false],
 ['default expression calls unknown code',source.replace('rate = 0','rate = load()'),null],
 ['default references another parameter',source.replace('rate = 0','rate = value'),null],
 ['computed intrinsic',source.replace('rate = 0',"rate = Number['MAX_SAFE_INTEGER']"),null],
 ['nested destructuring',source.replace('rate = 0','{rate} = {}'),null],
 ['rest parameter',source.replace('rate = 0','...rate'),null],
 ['default callback',source.replace('rate = 0','rate = () => 0'),null]
]) test(`static default API metadata: ${label}`,()=>assert.equal(compare(source,current).compatible,compatible));
for(const value of ['0','-0','1.5','"zero"','false','null','Number.MAX_SAFE_INTEGER'])test(`unchanged supported default ${value}`,()=>{
 const candidate=`export function total(value, rate = ${value}) { return 1; }`;
 assert.equal(compare(candidate,candidate).compatible,true);
});
test('negative zero default stays distinct',()=>assert.equal(compare(source,source.replace('rate = 0','rate = -0')).compatible,false));
test('Date default retains intrinsic spelling and function length',()=>{
 const before='export function expired(value, now = Date.now()) { return now >= value; }';
 const result=compare(before,before);assert.equal(result.compatible,true);assert.equal(result.baseline[0].functionLength,1);
 assert.equal(compare(before,before.replace('now = Date.now()','now')).compatible,false);
 assert.equal(compare(before,before.replace('value, now','Date, now')).compatible,null);
});
test('default metadata preserves pre-existing plain parameter contracts',()=>{
 const before='export function total(value, rate) { return 1; }';
 assert.deepEqual(compare(before,before).baseline,[{exportName:'total',callable:'sync-function',parameters:['value','rate'],result:'primitive:number'}]);
});

}

{
const compare = compareSupportedPublicApi;
const source='export function total(lines, rate = 0) { if (!Array.isArray(lines)) throw new TypeError("lines"); const subtotal = lines.reduce((sum, line) => sum + Number(line), 0); return Math.round(subtotal * (1 + rate)); }';
for(const [label,current,compatible] of [
 ['same numeric API',source,true],
 ['different arithmetic is not semantic proof',source.replace('sum + Number(line)','sum - Number(line)'),true],
 ['callback return is not public return',source.replace('sum + Number(line)','({sum})'),true],
 ['changed public arity',source.replace('rate = 0','rate = 0, options'),false],
 ['changed default',source.replace('rate = 0','rate = 1'),false],
 ['unknown public result',source.replace('return Math.round(subtotal * (1 + rate));','return subtotal;'),null],
 ['mixed public results',source.replace('const subtotal =','if (rate) return {}; const subtotal ='),null],
 ['fallthrough',source.replace('return Math.round','if (rate) return Math.round'),null],
 ['async callback',source.replace('(sum, line) =>','async (sum, line) =>'),null],
 ['missing initial accumulator',source.replace('Number(line), 0)','Number(line))'),null],
 ['computed reduce',source.replace('lines.reduce',"lines['reduce']"),null],
 ['shadowed intrinsic',source.replace('lines, rate = 0','Array, rate = 0'),null],
 ['shadowed callable inside callback',source.replace('(sum, line) =>','(total, line) =>'),null],
 ['escaping public callable',source.replace('sum + Number(line)','total'),null],
 ['rebound callable',source.replace('sum + Number(line)','(total = () => 1)'),null],
 ['nested unknown call',source.replace('Number(line)','line.execute()'),null],
 ['shadowed numeric intrinsic',source.replace('(sum, line) =>','(Number, line) =>'),null],
 ['ordinary function callback',source.replace('(sum, line) => sum + Number(line)','function(sum, line) { return sum + Number(line); }'),null]
])test(`closed numeric aggregate API: ${label}`,()=>assert.equal(compare(source,current).compatible,compatible));
for(const result of ['1','false'])test(`Date default metadata is independent of public primitive ${result}`,()=>{
 const candidate=`export function total(value, now = Date.now()) { return ${result}; }`;
 assert.equal(compare(candidate,candidate).compatible,true);
 assert.equal(compare(candidate,candidate.replace('value, now','Date, now')).compatible,null);
});

}

for(const directive of ['Fix', 'Repair']) test(`numeric API target binds exact ${directive} intent`, async t => {
 const [file,currentSource]=productionV3ReferenceSolution('invoice-rounding');const committedSource=fs.readFileSync(path.join(repositoryRoot,'benchmarks/production-v3/project',file),'utf8');
 const {input}=await fixture(t,{committedSource,currentSource,criterionText:'Do not change the exported API.',behaviorCriteria:[`${directive} \`invoiceTotalCents(lines, taxBps)\` in \`${sourcePath}\`.`]});
 assert.equal(apiBaselineCriterionEvidence(input).evidence?.kind,'task-baseline-public-api',JSON.stringify(apiBaselineCriterionEvidence(input)));
});

for(const directive of ['Repair `invoiceTotalCents(lines, taxBps)` in `src/foreign.js`.', 'Compare `invoiceTotalCents(lines, taxBps)` in `src/frontend/pagination.js`.', 'Repair `invoiceTotalCents(lines, taxBps)` in `src/frontend/pagination.js`. As an example only.']) test(`numeric repair intent rejects foreign or ambiguous authority: ${directive}`, async t => {
 const [file,currentSource]=productionV3ReferenceSolution('invoice-rounding');const committedSource=fs.readFileSync(path.join(repositoryRoot,'benchmarks/production-v3/project',file),'utf8');
 const {input}=await fixture(t,{committedSource,currentSource,criterionText:'Do not change the exported API.',behaviorCriteria:[directive]});
 assert.equal(apiBaselineCriterionEvidence(input).reason,'api-unrelated-implementation-changed');
});
test('numeric repair intent does not authorize unrelated public implementation changes',async t=>{
 const [file,currentSource]=productionV3ReferenceSolution('invoice-rounding');const committedSource=fs.readFileSync(path.join(repositoryRoot,'benchmarks/production-v3/project',file),'utf8');
 const {input}=await fixture(t,{committedSource:committedSource+'\nexport function apiVersion() { return 1; }',currentSource:currentSource+'\nexport function apiVersion() { return 2; }',criterionText:'Do not change the exported API.',behaviorCriteria:['Repair `invoiceTotalCents(lines, taxBps)` in `src/frontend/pagination.js`.']});
 assert.equal(apiBaselineCriterionEvidence(input).reason,'api-unrelated-implementation-changed');
});

test('compound invalid-input requirement cannot borrow an unrelated argument rejection',async t=>{
 const committedSource='export function invoiceTotalCents(lines, taxBps = 0) { return 0; }';
 const currentSource='export function invoiceTotalCents(lines, taxBps = 0) { if (!Number.isSafeInteger(taxBps) || taxBps < 0) throw new TypeError("invalid integer"); return 1; }';
 const context=await fixture(t,{committedSource,currentSource,criterionText:'Reject negative/non-integer money or quantity inputs with `TypeError`;',behaviorCriteria:[]});
 fs.writeFileSync(path.join(context.cwd,testPath),"import assert from 'node:assert/strict'; import test from 'node:test'; import {invoiceTotalCents} from '../src/frontend/pagination.js'; test('negative and non-integer inputs',()=>{ for(const invalid of [-1,0.5]) assert.throws(()=>invoiceTotalCents([{unitCents:1,quantity:1}],invalid),TypeError); });");
 const input=context.refresh();const receipt=refreshAcceptanceReceipt(input.task,input).receipt;
 const actual=await import(`file://${context.cwd}/${sourcePath}`);assert.equal(actual.invoiceTotalCents([{unitCents:-1,quantity:-1}]),1);
 t.diagnostic(JSON.stringify({criterionText:input.task.acceptanceCriteria[0],criterion:receipt.criteria[0],badLineObservedResult:1,verifierExitCode:input.task.verifyEvidence[0].exitCode}));
 assert.equal(receipt.criteria[0].status,'pending','the executed counterexample accepts bad money/quantity while only the unrelated tax argument is tested');
});

test('compound input receipt accepts separately verified and guarded requested parameters',async t=>{
 const committedSource='export function total(money, quantity, tax) { return 0; }';const currentSource='export function total(money, quantity, tax) { if (!Number.isInteger(money) || money < 0) throw new TypeError(); if (!Number.isInteger(quantity) || quantity < 0) throw new TypeError(); return money * quantity; }';
 const context=await fixture(t,{committedSource,currentSource,criterionText:'Reject negative/non-integer money or quantity inputs with `TypeError`;',behaviorCriteria:[]});
 fs.writeFileSync(path.join(context.cwd,testPath),"import assert from 'node:assert/strict'; import test from 'node:test'; import {total} from '../src/frontend/pagination.js'; test('both declared inputs',()=>{ assert.equal(total(2,3,0),6); for(const invalid of [-1,0.5]) { assert.throws(()=>total(invalid,1,0),TypeError); assert.throws(()=>total(1,invalid,0),TypeError); } });");
 const input=context.refresh();const receipt=refreshAcceptanceReceipt(input.task,input).receipt;
 assert.equal(receipt.criteria[0].status,'satisfied',JSON.stringify(receipt.criteria[0]));
});

{
const compare = compareSupportedPublicApi;
const source='export function reached(timestamp, now) { return now >= timestamp; }';
for(const [label,current,compatible] of [
 ['one internal rename',source.replaceAll('timestamp','expiresAt'),true],
 ['all internal names renamed',source.replaceAll('timestamp','first').replaceAll('now','second'),true],
 ['retained names reordered',source.replace('timestamp, now','now, timestamp'),false],
 ['retained name moved alongside rename',source.replaceAll('timestamp','first').replace('first, now','now, first'),false],
 ['arity added',source.replace('timestamp, now','timestamp, now, extra'),false],
 ['arity removed','export function reached(timestamp) { return timestamp >= 0; }',false],
 ['export renamed',source.replace('function reached','function other'),false],
 ['different result representation',source.replace('now >= timestamp','1'),false],
 ['async declaration',source.replace('export function','export async function'),null],
 ['rest syntax',source.replace('timestamp, now','timestamp, ...now'),null],
 ['destructured parameter',source.replace('timestamp, now','{timestamp}, now'),null],
 ['behavior is still a separate obligation',source.replaceAll('timestamp','expiresAt').replace('>=','<'),true]
])test(`positional API with internal names: ${label}`,()=>assert.equal(compare(source,current).compatible,compatible));
for(const [label,current,compatible] of [
 ['default retained','value, rate = 0',true],['default changed','value, rate = 1',false],['default removed','value, rate',false],['default moved','value = 0, rate',false]
])test(`internal rename preserves optional convention: ${label}`,()=>{
 const before='export function total(amount, tax = 0) { return Math.round(amount * tax); }';
 const after=`export function total(${current}) { return Math.round(value * rate); }`;
 assert.equal(compare(before,after).compatible,compatible);
});

}

test('internal parameter rename preserves positional public calling convention', async () => {
 const before='export function reached(timestamp, now) { return now >= timestamp; }';
 const after='export function reached(expiresAt, now) { return now >= expiresAt; }';
 const load=source=>import('data:text/javascript,'+encodeURIComponent(source));
 const [a,b]=await Promise.all([load(before),load(after)]);
 assert.equal(a.reached.name,b.reached.name); assert.equal(a.reached.length,b.reached.length);
 for(const args of [[0,0],[1,0],[0,1],[-1,0]]) assert.equal(a.reached(...args),b.reached(...args));
 assert.equal(compareSupportedPublicApi(before,after).compatible,true);
});

for (const [label, directive, unrelated, accepted] of [
  ['exact target', true, false, true],
  ['missing target', false, false, false],
  ['unrelated public body also changes', true, true, false]
]) test(`internal parameter rename retains source-change authority: ${label}`, async t => {
  const committedSource = 'export function reached(timestamp, now) { return now >= timestamp; }\nexport function apiVersion() { return 1; }';
  const currentSource = committedSource.replaceAll('timestamp', 'expiresAt').replace('return 1', unrelated ? 'return 2' : 'return 1');
  const { input } = await fixture(t, { committedSource, currentSource, criterionText: 'Preserve the API and verify the project.',
    behaviorCriteria: directive ? [`Fix \`reached(timestamp, now)\` in \`${sourcePath}\`.`] : [] });
  const result = apiBaselineCriterionEvidence(input);
  if (accepted) assert.equal(result.evidence?.kind, 'task-baseline-public-api', JSON.stringify(result));
  else assert.equal(result.reason, 'api-unrelated-implementation-changed');
});
