import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash, WORKING_TREE_DIGEST_ALGORITHM } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { automaticAcceptanceCriteria } from "../packages/piagent-core/runtime/workflows/task-intake.ts";

const CURRENT_DIGEST = versionWorkingTreeHash("d".repeat(64));
const COMPOUND_INPUT = "Contract: `jobs` must be an array; `nowMs` and `leadMs` must be non-negative safe integers; `limit` must be a positive safe integer";
const RESULT_CONTRACT = "return only their IDs, capped at `limit`;";

function temporaryProject(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-conjunctive-proof-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function sourceText(name, variant = "complete") {
  const leadGuard = variant === "partial-input" ? "" : "  if (!Number.isSafeInteger(leadMs) || leadMs < 0) throw new TypeError('leadMs');\n";
  const cap = variant === "wrong-cap" ? "limit + 1" : "limit";
  const projection = variant === "wrong-shape" ? "job" : "job.id";
  return [
    `export function ${name}(jobs, nowMs, leadMs, limit) {`,
    "  if (!Array.isArray(jobs)) throw new TypeError('jobs');",
    "  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('nowMs');",
    leadGuard.trimEnd(),
    "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
    "  return jobs",
    "    .filter((job) => job.expiresAt > nowMs && job.expiresAt <= nowMs + leadMs)",
    `    .slice(0, ${cap})`,
    `    .map((job) => ${projection});`,
    "}",
    ""
  ].filter(Boolean).join("\n");
}

function testText(sourceName, localName, variant = "complete") {
  if (variant === "detached") {
    return "import assert from 'node:assert/strict';\nassert.deepEqual(['a', 'b'], ['a', 'b']);\n";
  }
  const leadAssertion = variant === "partial-input"
    ? ""
    : `assert.throws(() => ${localName}([], 0, -1, 1), TypeError);`;
  const expected = variant === "wrong-shape"
    ? "jobs.slice(0, 2)"
    : "['a', 'b']";
  return [
    "import assert from 'node:assert/strict';",
    `import { ${sourceName}${localName === sourceName ? "" : ` as ${localName}`} } from '../src/jobs.js';`,
    "const jobs = [",
    "  { id: 'a', expiresAt: 10 },",
    "  { id: 'b', expiresAt: 20 },",
    "  { id: 'c', expiresAt: 30 },",
    "  { id: 'd', expiresAt: 40 }",
    "];",
    `assert.deepEqual(${localName}(jobs, 0, 100, 2), ${expected});`,
    `assert.throws(() => ${localName}(null, 0, 0, 1), TypeError);`,
    `assert.throws(() => ${localName}([], -1, 0, 1), TypeError);`,
    leadAssertion,
    `assert.throws(() => ${localName}([], 0, 0, 0), TypeError);`,
    ""
  ].filter(Boolean).join("\n");
}

function refreshedFixture(t, { sourceName = "selectJobs", localName = sourceName, sourceVariant = "complete", testVariant = sourceVariant } = {}) {
  const cwd = temporaryProject(t);
  fs.writeFileSync(path.join(cwd, "src", "jobs.js"), sourceText(sourceName, sourceVariant));
  fs.writeFileSync(path.join(cwd, "test", "jobs.test.js"), testText(sourceName, localName, testVariant));
  const criteria = [
    COMPOUND_INPUT,
    "invalid input throws `TypeError`;",
    RESULT_CONTRACT,
    "do not mutate the input array.",
    "The configured verification command passes after the final mutation."
  ];
  const built = buildAcceptanceReceipt({
    summary: `Implement \`${sourceName}\` with bounded validation and output.`,
    expectedOutput: "The exact requested behavior is implemented.",
    acceptanceCriteria: criteria,
    changeMode: "source-change",
    source: "runtime",
    generatedAt: "2026-09-04T00:00:00.000Z"
  });
  const changedFiles = ["src/jobs.js", "test/jobs.test.js"];
  const criterionGraph = compileCriterionGraph({
    acceptanceCriteria: built.acceptanceCriteria,
    scope: ["src/jobs.js", "test/**"],
    verifyCommands: ["npm test"],
    changeMode: "source-change",
    createdAt: "2026-09-04T00:00:00.000Z"
  });
  const task = {
    schemaVersion: 2,
    changeMode: "source-change",
    summary: `Implement \`${sourceName}\` with bounded validation and output.`,
    expectedOutput: "The exact requested behavior is implemented.",
    acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt,
    criterionGraph,
    scope: ["src/jobs.js", "test/**"],
    outOfScope: [],
    protectedPaths: [],
    changedFiles,
    observedChangedFiles: changedFiles,
    verifyCommands: ["npm test"],
    verifyEvidence: [{
      command: "npm test",
      exitCode: 0,
      observed: true,
      matchedProfileCommand: true,
      preWorkingTreeDigest: CURRENT_DIGEST,
      workingTreeDigest: CURRENT_DIGEST,
      recordedAt: "2026-09-04T00:00:01.000Z"
    }],
    workingTreeDigestAlgorithm: WORKING_TREE_DIGEST_ALGORITHM,
    trace: { outcome: "completed" }
  };
  return refreshAcceptanceReceipt(task, {
    cwd,
    changedFiles,
    currentWorkingTreeDigest: CURRENT_DIGEST,
    recordedAt: "2026-09-04T00:00:02.000Z"
  });
}

function missingText(result) {
  const missing = new Set(result.criticalMissing.map((criterion) => criterion.hash));
  return result.task.acceptanceCriteria.filter((_criterion, index) => missing.has(result.receipt.criteria[index].hash));
}

test("automatic intake gives each top-level semicolon conjunct its own stable criterion", () => {
  const criteria = automaticAcceptanceCriteria([
    "Implement `selectJobs`.",
    "",
    `- ${COMPOUND_INPUT}; invalid input throws TypeError;`,
    `- ${RESULT_CONTRACT}`
  ].join("\n"));
  assert.ok(criteria.includes("Contract: `jobs` must be an array;"));
  assert.ok(criteria.includes("`nowMs` and `leadMs` must be non-negative safe integers;"));
  assert.ok(criteria.includes("`limit` must be a positive safe integer;"));
});

test("retained compound input and result-shape criteria receive conjunctive executable proof", (t) => {
  const result = refreshedFixture(t);
  assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[0].hash), false);
  assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[2].hash), false);
});

test("partial validation, wrong cap, wrong shape, and detached green assertions remain unproven", async (t) => {
  const variants = [
    { sourceVariant: "partial-input", missingIndex: 0 },
    { sourceVariant: "wrong-cap", missingIndex: 2 },
    { sourceVariant: "wrong-shape", missingIndex: 2 },
    { testVariant: "detached", missingIndex: 2 }
  ];
  for (const variant of variants) {
    await t.test(variant.sourceVariant ?? variant.testVariant, (child) => {
      const result = refreshedFixture(child, variant);
      assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[variant.missingIndex].hash), true, JSON.stringify(missingText(result)));
    });
  }
});

test("proof follows a statically imported renamed callable instead of lexical name overlap", (t) => {
  const result = refreshedFixture(t, { sourceName: "selectJobs", localName: "choose" });
  assert.equal(result.criticalMissing.some((criterion) => criterion.hash === result.receipt.criteria[2].hash), false);
});
import { spawnSync as executeFallbackVerifier } from "node:child_process";

// Finite interval records: field identity comes from the task and real imports.
function intervalFixture(options = {}) {
  const source = options.source ?? `function whole(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function classifyArrival(packet, frame) {
  if (!packet || typeof packet !== 'object' || !frame || typeof frame !== 'object'
    || ![packet.stamp, packet.receipt, frame.lo, frame.hi, frame.tolerance].every(whole)
    || frame.tolerance < 0 || frame.lo >= frame.hi) throw new TypeError('invalid interval');
  if (packet.stamp < frame.lo || packet.stamp >= frame.hi) return 'outside';
  if (packet.receipt < packet.stamp - frame.tolerance) return 'early';
  if (packet.receipt >= frame.hi + frame.tolerance) return 'late';
  return 'current';
}`;
  const tests = options.tests ?? `import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyArrival } from '../src/interval.js';
const sample = (changes = {}) => ({ stamp: 10, receipt: 10, ...changes });
const range = (changes = {}) => ({ lo: 10, hi: 20, tolerance: 2, ...changes });
test('typed fields and interval relations', () => {
  for (const invalid of [NaN, Infinity, -Infinity, 0.5, '10', null, undefined]) {
    for (const field of ['stamp', 'receipt']) assert.throws(() => classifyArrival(sample({ [field]: invalid }), range()), TypeError);
    for (const field of ['lo', 'hi', 'tolerance']) assert.throws(() => classifyArrival(sample(), range({ [field]: invalid })), TypeError);
  }
  assert.throws(() => classifyArrival(sample(), range({ tolerance: -1 })), TypeError);
  assert.throws(() => classifyArrival(sample(), range({ hi: 10 })), TypeError);
  assert.throws(() => classifyArrival(sample(), range({ hi: 9 })), TypeError);
  for (const invalid of [null, undefined, 1, '', {}]) {
    assert.throws(() => classifyArrival(invalid, range()), TypeError);
    assert.throws(() => classifyArrival(sample(), invalid), TypeError);
  }
});`;
  const context = options.context ?? 'Preserve `classifyArrival(packet, frame)`. Use the half-open interval `lo <= stamp < hi`. '
    + '`receipt` is earlier than `stamp` by more than `tolerance`. Receipt at or after `hi + tolerance` is late. '
    + 'All timestamps and the skew must be finite integers; the skew must be non-negative; require `lo < hi`; malformed values throw `TypeError`.';
  return {taskText: options.selected ?? 'malformed values throw `TypeError`.', contextText: context,
    sourceText: source, testText: tests, sourceEntries: [{path:'src/interval.js',text:source}],
    testEntries: [{path:'test/interval.test.js',text:tests}], namedTargets: options.inferred ? [] : ['classifyArrival']};
}

function fallbackFixture() {
  const original=intervalFixture();
  const context='Preserve `classifyArrival(packet, frame)`. The interval is half-open: `lo <= stamp < hi`. '
    +'Return `outside` for an occurrence outside that interval. For an in-period event, return `early` when `receipt` is earlier than `stamp` by more than `tolerance`; '
    +'return `late` when receipt is at or after `hi + tolerance`; otherwise return `current`. '
    +'All timestamps and the skew must be finite integers, the skew must be non-negative, and the period must have `lo < hi`; malformed values throw `TypeError`.';
  const tests=original.testText.slice(0,original.testText.indexOf("test('typed"))+"test('default result', () => { assert.equal(classifyArrival(sample({stamp:11,receipt:11}),range()),'current'); });";
  return {source:original.sourceText,tests,context,selected:'otherwise return `current`.'};
}
const fallbackCases=[
 ['declared default',x=>x,'satisfied'],
 ['wrong final result',x=>({...x,source:x.source.replace("return 'current';","return 'late';"),tests:x.tests.replace("'current');","'late');") }),'pending'],
 ['missing typed guard',x=>({...x,source:x.source.replace('packet.receipt, ','')}),'pending'],
 ['constant result',x=>({...x,source:"export function classifyArrival(packet, frame) { return 'current'; }"}),'pending'],
 ['wrong outside boundary',x=>({...x,source:x.source.replace('packet.stamp < frame.lo','packet.stamp <= frame.lo')}),'pending'],
 ['wrong early boundary',x=>({...x,source:x.source.replace('packet.receipt < packet.stamp','packet.receipt <= packet.stamp')}),'pending'],
 ['wrong late boundary',x=>({...x,source:x.source.replace('packet.receipt >= frame.hi','packet.receipt > frame.hi')}),'pending'],
 ['late guard absent',x=>({...x,source:x.source.replace("  if (packet.receipt >= frame.hi + frame.tolerance) return 'late';\n",'')}),'pending'],
 ['late uses wrong offset',x=>({...x,source:x.source.replace('frame.hi + frame.tolerance','frame.hi - frame.tolerance')}),'pending'],
 ['conditional final expression',x=>({...x,source:x.source.replace("return 'current';","return packet.receipt === 11 ? 'current' : 'late';")}),'pending'],
 ['unreachable final literal',x=>({...x,source:x.source.replace("return 'current';","if(packet.receipt === 11) return 'current'; return 'late'; return 'current';")}),'pending'],
 ['reordered earlier branches',x=>({...x,source:x.source.replace(/(  if \(packet.stamp[^\n]+\n)(  if \(packet.receipt <[^\n]+\n)/,'$2$1')}),'pending'],
 ['detached expected literal',x=>({...x,tests:x.tests.replace("classifyArrival(sample({stamp:11,receipt:11}),range())","'current'")}),'pending'],
 ['skipped result test',x=>({...x,tests:x.tests.replace("test('default", "test.skip('default") }),'pending'],
 ['dead result assertion',x=>({...x,tests:x.tests.replace("() => { assert.equal", "() => { return; assert.equal") }),'pending'],
 ['shadowed target',x=>({...x,tests:x.tests.replace("() => { assert.equal", "() => { const classifyArrival = () => 'current'; assert.equal") }),'pending'],
 ['altered assertion intrinsic',x=>({...x,tests:x.tests.replace("() => { assert.equal", "() => { assert.equal = () => {}; assert.equal") }),'pending'],
 ['Array alias mutation',x=>({...x,tests:x.tests.replace("() => { assert.equal", "() => { const borrowed=Array; borrowed.prototype.every=()=>true; assert.equal") }),'pending'],
 ['factory result overwritten',x=>({...x,tests:x.tests.replace('stamp: 10, receipt: 10, ...changes','...changes, stamp: 10, receipt: 10')}),'pending'],
 ['wrong observed result domain',x=>({...x,tests:x.tests.replace('stamp:11,receipt:11','stamp:9,receipt:9').replace("'current');","'outside');")}),'pending'],
 ['context missing earlier branches',x=>({...x,context:'Preserve the API; otherwise return `current`. Malformed values throw `TypeError`.'}),'pending'],
 ['context has conflicting fallback',x=>({...x,context:x.context+' Otherwise return `other`.'}),'pending'],
 ['renamed fields and results',x=>{
   let data=JSON.stringify(x);
   for(const [from,to] of [['classifyArrival','routeReceipt'],['stamp','emitted'],['receipt','arrived'],['tolerance','allowance'],['packet','record'],['frame','interval'],['current','active'],['outside','excluded'],['early','skewed'],['late','delayed']]) {
     // Rename literal labels without changing prose such as outside an interval.
     if(['current','outside','early','late'].includes(from)) data=data.replaceAll('`'+from+'`','`'+to+'`').replaceAll("'"+from+"'","'"+to+"'");
     else if(from!=='receipt') data=data.replace(new RegExp('\\b'+from+'\\b','g'),to);
   }
   return JSON.parse(data);
 },'satisfied']
];
for(const [label,change,expected] of fallbackCases) test(`otherwise literal after actual verifier: ${label}`,t=>{
  const fixture=change(fallbackFixture()),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-fallback-receipt-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const sourcePath='interval.mjs',testPath='interval.test.mjs',command=`node --test ${testPath}`;
  fs.writeFileSync(path.join(cwd,sourcePath),fixture.source);
  fs.writeFileSync(path.join(cwd,testPath),fixture.tests.replace('../src/interval.js','./interval.mjs'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
  const run=executeFallbackVerifier(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr);
  const built=buildAcceptanceReceipt({summary:'Validate the declared otherwise result.',expectedOutput:fixture.context,acceptanceCriteria:[fixture.selected],changeMode:'source-change',source:'runtime'});
  const digest=versionWorkingTreeHash('9'.repeat(64));
  const task={...built,acceptanceReceipt:built.receipt,scope:[sourcePath,testPath],criterionGraph:compileCriterionGraph({acceptanceCriteria:built.acceptanceCriteria,scope:[sourcePath,testPath],verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),summary:'Validate the declared otherwise result.',expectedOutput:fixture.context,changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:[sourcePath,testPath],verifyCommands:[command],
    verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
  const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});
  assert.equal(refresh(task).receipt.criteria[0].status,expected);
  if(expected==='satisfied') for(const changed of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},
    {...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('8'.repeat(64))}]}]) assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
});
