import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

test("current executed rejection tests and unestablished source proof require assessment, not an automatic diagnosis", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-source-proof-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sourcePath = "numeric.mjs", testPath = "numeric.test.mjs";
  const source = "function validate(value) { if (!Number.isInteger(value)) throw new TypeError(); }\n"
    + "export function requireCount(count) { validate(count); return count; }\n";
  const tests = "import assert from 'node:assert/strict';\nimport { requireCount } from './numeric.mjs';\n"
    + "assert.throws(() => requireCount(1.5), TypeError);\n";
  fs.writeFileSync(path.join(cwd, sourcePath), source);
  fs.writeFileSync(path.join(cwd, testPath), tests);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", testPath], { cwd, env, encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /(?:#|ℹ)\s+tests 1\b/);
  assert.match(run.stdout, /(?:#|ℹ)\s+skipped 0\b/);
  const text = "`requireCount` must reject a non-integer count with `TypeError`;";
  const built = buildAcceptanceReceipt({ summary: text, acceptanceCriteria: [text], changeMode: "source-change", source: "runtime" });
  const digest = versionWorkingTreeHash("a".repeat(64)), command = `node --test ${testPath}`;
  const task = { ...built, acceptanceReceipt: built.receipt, summary: text, changeMode: "source-change",
    workingTreeDigestAlgorithm: "wt-content-v2", changedFiles: [sourcePath, testPath], verifyCommands: [command],
    verifyEvidence: [{ command, exitCode: run.status, observed: true, matchedProfileCommand: true,
      preWorkingTreeDigest: digest, workingTreeDigest: digest, recordedAt: "2026-09-06T00:00:00.000Z" }] };
  const refresh = candidate => refreshAcceptanceReceipt(candidate, { cwd, currentWorkingTreeDigest: digest });
  const observed = refresh(task);
  assert.equal(observed.receipt.criteria[0].status, "pending", "missing source proof never becomes acceptance");
  assert.equal(observed.sourceProofRequired?.length, 1);
  assert.deepEqual(observed.receipt.criteria[0].evidence, []);
  for (const candidate of [
    { ...task, verifyEvidence: [] },
    { ...task, verifyEvidence: [{ ...task.verifyEvidence[0], exitCode: 1 }] },
    { ...task, verifyEvidence: [{ ...task.verifyEvidence[0], workingTreeDigest: versionWorkingTreeHash("b".repeat(64)) }] },
    { ...task, verifyCommands: ["node --test other.test.mjs"], verifyEvidence: [{ ...task.verifyEvidence[0], command: "node --test other.test.mjs" }] }
  ]) assert.equal(refresh(candidate).sourceProofRequired?.length, 0, "unexecuted/failed/stale/uncovered tests retain their own recovery route");
  fs.writeFileSync(path.join(cwd, testPath), "import { requireCount } from './numeric.mjs';\n");
  assert.equal(refresh(task).sourceProofRequired?.length, 0, "missing live focused assertions can still be supplied");
});

{
const text = 'Reject negative/non-integer money or quantity inputs with `TypeError`;';
const context = 'All values are integer cents or basis points. For each row, multiply `priceCents` by the positive integer `quantity` (default 1).';
const source = `function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError();
  return value;
}
export function aggregate(items, fee = 0) {
  if (!Array.isArray(items)) throw new TypeError();
  integer(fee, 0, 100);
  const total = items.reduce((sum, row) => {
    const amount = integer(row?.priceCents, 0);
    const quantity = integer(row?.quantity ?? 1, 1);
    return sum + amount * quantity;
  }, 0);
  return total + fee;
}`;
const imports = 'import assert from "node:assert/strict"; import { aggregate } from "./numeric.mjs"; ';
const money = 'for (const priceCents of [-1,0.5]) { assert.throws(() => aggregate([{priceCents,quantity:1}]),TypeError); }';
const quantity = 'for (const quantity of [-1,0.5]) { assert.throws(() => aggregate([{priceCents:1,quantity}]),TypeError); }';
for (const [label,code,body,related,expected] of [
  ['original declared fields',source,money+quantity,context,'satisfied'],
  ['tax-only verifier cannot hide missing money guard',source.replace('integer(row?.priceCents, 0)','row?.priceCents'),
    'for (const fee of [-1,0.5]) { assert.throws(() => aggregate([{priceCents:1,quantity:1}],fee),TypeError); } assert.equal(aggregate([{priceCents:-1,quantity:1}]),-1);',context,'pending'],
  ['money-only verifier cannot hide missing quantity guard',source.replace('integer(row?.quantity ?? 1, 1)','(row?.quantity ?? 1)'),
    money+' assert.equal(aggregate([{priceCents:1,quantity:0.5}]),0.5);',context,'pending'],
  ['one invalid field cannot cover both obligations',source,money.replace('quantity:1','quantity:-1')+quantity.replace('priceCents:1','priceCents:-1'),context,'pending'],
  ['native reducer replaced through an alias',source,'const borrowed = Array; borrowed.prototype.reduce = () => {throw new TypeError();};'+money+quantity,context,'pending'],
  ['context is required even after real passing tests',source,money+quantity,'','pending']
]) test(`record integer receipt after real passing verifier: ${label}`, t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'piagent-record-receipt-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const sourcePath='numeric.mjs',testPath='numeric.test.mjs',command=`node --test ${testPath}`;
  fs.writeFileSync(path.join(cwd,sourcePath),code); fs.writeFileSync(path.join(cwd,testPath),imports+body);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['--test',testPath],{cwd,env,encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr); assert.match(run.stdout,/(?:#|ℹ)\s+tests 1\b/);assert.match(run.stdout,/(?:#|ℹ)\s+skipped 0\b/);
  const built=buildAcceptanceReceipt({summary:'Validate record integer inputs.',expectedOutput:related,acceptanceCriteria:[text],changeMode:'source-change',source:'runtime'});
  const digest=versionWorkingTreeHash('c'.repeat(64));
  const task={...built,acceptanceReceipt:built.receipt,summary:'Validate record integer inputs.',expectedOutput:related,changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:[sourcePath,testPath],verifyCommands:[command],
    verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-06T00:00:00.000Z'}]};
  const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});
  assert.equal(refresh(task).receipt.criteria[0].status,expected);
  if(expected==='satisfied') for(const changed of [
    {...task,verifyEvidence:[]},
    {...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},
    {...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('d'.repeat(64))}]}
  ]) assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
});
}

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

{
const original=intervalFixture();
const nullOnly=`import assert from 'node:assert/strict'; import test from 'node:test'; import { classifyArrival } from '../src/interval.js';
test('only object rejection', () => { for(const invalid of [null,undefined]) {
assert.throws(()=>classifyArrival(invalid,{lo:10,hi:20,tolerance:2}),TypeError);
assert.throws(()=>classifyArrival({stamp:10,receipt:10},invalid),TypeError);
} });`;
for (const [label,source,tests,expected] of [
  ['complete original fields',original.sourceText,original.testText,'satisfied'],
  ['missing receipt guard despite passing null-only tests',original.sourceText.replace('packet.receipt, ',''),nullOnly,'pending'],
  ['wrong receiver despite passing null-only tests',original.sourceText.replace('packet.receipt,','frame.receipt,'),nullOnly,'pending'],
  ['null-only tests cannot establish every field',original.sourceText,nullOnly,'pending'],
  ['missing receipt examples',original.sourceText,original.testText.replace(", 'receipt'",''),'pending'],
  ['other argument masks whole-object case',original.sourceText,original.testText.replace('classifyArrival(invalid, range())','classifyArrival(invalid, range({ tolerance: -1 }))'),'pending'],
  ['native every replaced through Array alias',original.sourceText,original.testText.replace("test('typed", "const borrowed = Array; borrowed.prototype.every = () => false;\ntest('typed"),'pending'],
]) test(`finite record receipt after real passing verifier: ${label}`,t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-finite-record-receipt-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const sourcePath='interval.mjs',testPath='interval.test.mjs',command=`node --test ${testPath}`;
  fs.writeFileSync(path.join(cwd,sourcePath),source);
  fs.writeFileSync(path.join(cwd,testPath),tests.replace('../src/interval.js','./interval.mjs'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/# tests 1\b/);assert.match(run.stdout,/# skipped 0\b/);
  const built=buildAcceptanceReceipt({summary:'Validate finite record fields.',expectedOutput:original.contextText,acceptanceCriteria:[original.taskText],changeMode:'source-change',source:'runtime'});
  const digest=versionWorkingTreeHash('e'.repeat(64));
  const task={...built,acceptanceReceipt:built.receipt,summary:'Validate finite record fields.',expectedOutput:original.contextText,changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:[sourcePath,testPath],verifyCommands:[command],
    verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
  const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});
  assert.equal(refresh(task).receipt.criteria[0].status,expected);
  if(expected==='satisfied') for(const changed of [
    {...task,verifyEvidence:[]}, {...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},
    {...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('f'.repeat(64))}]}
  ]) assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
});
}
import { compileCriterionGraph as compileCachedGraph } from "../packages/piagent-core/extensions/criterion-graph.js";

function cacheFixture(options={}) {
  const source=options.source ?? `function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function label(value) { return typeof value === 'string' && value.length > 0; }
function whole(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function canReuse(grant, query) {
  if (!object(grant) || !object(query)
    || ![grant.teamId, grant.subjectId, grant.action, query.teamId, query.subjectId, query.action].every(label)
    || ![grant.policyRevision, grant.evaluationTime, grant.until, query.currentPolicyRevision, query.at].every(whole)
    || (query.revocation !== null && !whole(query.revocation))) throw new TypeError('invalid grant');
  return grant.teamId === query.teamId && grant.subjectId === query.subjectId && grant.action === query.action
    && grant.policyRevision === query.currentPolicyRevision && grant.evaluationTime <= query.at && query.at < grant.until
    && !(query.revocation !== null && query.revocation <= query.at);
}`;
  const context=options.context ?? 'Preserve `canReuse(grant, query)`. Both inputs have matching non-empty team, subject, and action identifiers; '
    +'the cached policy revision equals the current policy revision; evaluation is not in the future; and `query.at` is strictly before `grant.until`. '
    +'A revocation at or before `query.at` invalidates the entry. Validate all time and revision fields as finite integers; '
    +'`query.revocation` must be either null or a finite integer. Throw `TypeError` for malformed input. Do not mutate either argument.';
  const imports=`import assert from 'node:assert/strict'; import test from 'node:test'; import {canReuse} from '../src/grant.js';
const makeGrant = (changes = {}) => ({ teamId:'north',subjectId:'person',action:'edit',policyRevision:3,evaluationTime:10,until:20,...changes });
const makeQuery = (changes = {}) => ({ teamId:'north',subjectId:'person',action:'edit',currentPolicyRevision:3,at:10,revocation:null,...changes });\n`;
  const matrix=`test('object and every declared field', () => {
 for(const invalid of [null,undefined,[],1,'',{}]) {
  assert.throws(()=>canReuse(invalid,makeQuery()),TypeError); assert.throws(()=>canReuse(makeGrant(),invalid),TypeError);
 }
 for(const field of ['teamId','subjectId','action']) for(const invalid of ['',null,1,undefined]) {
  assert.throws(()=>canReuse(makeGrant({[field]:invalid}),makeQuery()),TypeError);
  assert.throws(()=>canReuse(makeGrant(),makeQuery({[field]:invalid})),TypeError);
 }
 for(const invalid of [NaN,Infinity,-Infinity,0.25,'10',null,undefined]) {
  for(const field of ['policyRevision','evaluationTime','until']) assert.throws(()=>canReuse(makeGrant({[field]:invalid}),makeQuery()),TypeError);
  for(const field of ['currentPolicyRevision','at']) assert.throws(()=>canReuse(makeGrant(),makeQuery({[field]:invalid})),TypeError);
  if(invalid !== null) assert.throws(()=>canReuse(makeGrant(),makeQuery({revocation:invalid})),TypeError);
 }
});`;
  const snapshots=`test('true false and throwing calls preserve both records', () => {
 for(const input of [makeQuery(),makeQuery({revocation:10}),makeQuery({at:'10'})]) {
  const cached=makeGrant(), beforeGrant=structuredClone(cached), beforeQuery=structuredClone(input);
  if(typeof input.at === 'string') assert.throws(()=>canReuse(cached,input),TypeError);
  else canReuse(cached,input);
  assert.deepEqual(cached,beforeGrant); assert.deepEqual(input,beforeQuery);
 }
});`;
  const tests=options.tests ?? imports+matrix+snapshots;
  return {source,context,imports,matrix,snapshots,tests,input:{taskText:'Throw `TypeError` for malformed input.',contextText:context,sourceText:source,testText:tests,
    sourceEntries:[{path:'src/grant.js',text:source}],testEntries:[{path:'test/grant.test.js',text:tests}],namedTargets:options.inferred?[]:['canReuse']}};
}

function runCacheReceipt(t,fixture,selected,expected) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-cached-record-control-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const sourcePath='grant.mjs',testPath='grant.test.mjs',command=`node --test ${testPath}`,scope=[sourcePath,testPath];
 fs.writeFileSync(path.join(cwd,sourcePath),fixture.source);fs.writeFileSync(path.join(cwd,testPath),fixture.tests.replace('../src/grant.js','./grant.mjs'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);
 const built=buildAcceptanceReceipt({summary:'Validate cached grant records.',expectedOutput:fixture.context,acceptanceCriteria:[selected],changeMode:'source-change',source:'runtime'});
 const digest=versionWorkingTreeHash('5'.repeat(64));
 const task={...built,acceptanceReceipt:built.receipt,scope,criterionGraph:compileCachedGraph({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),summary:'Validate cached grant records.',expectedOutput:fixture.context,changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
 const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});
 assert.equal(refresh(task).receipt.criteria[0].status,expected);
 if(expected==='satisfied')for(const changed of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},{...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('4'.repeat(64))}]}])assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
 if(fixture.arrayWitness){
  const script="import {canReuse} from './grant.mjs';const grant=Object.assign([],{teamId:'north',subjectId:'person',action:'edit',policyRevision:3,evaluationTime:10,until:20});const query={teamId:'north',subjectId:'person',action:'edit',currentPolicyRevision:3,at:10,revocation:null};console.log(canReuse(grant,query));";
  const witness=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(witness.status,0,witness.stderr);assert.equal(witness.stdout.trim(),'true','Array with valid-looking properties was wrongly accepted by this source');
 }
}
const cacheNullOnly="test('null only',()=>{ for(const invalid of [null,undefined]) { assert.throws(()=>canReuse(invalid,makeQuery()),TypeError); assert.throws(()=>canReuse(makeGrant(),invalid),TypeError); } });";
for(const [label,change,expected] of [
 ['all field classes',x=>x,'satisfied'],
 ['null-only verifier',x=>({...x,tests:x.imports+cacheNullOnly}),'pending'],
 ['missing nullable guard with passing null-only tests',x=>({...x,source:x.source.replace('(query.revocation !== null && !whole(query.revocation))','false'),tests:x.imports+cacheNullOnly}),'pending'],
 ['string guard missing with passing null-only tests',x=>({...x,source:x.source.replace('grant.teamId, ',''),tests:x.imports+cacheNullOnly}),'pending'],
 ['revision guard missing with passing null-only tests',x=>({...x,source:x.source.replace('grant.policyRevision, ',''),tests:x.imports+cacheNullOnly}),'pending'],
 ['arrays with fields admitted despite all public-shaped tests passing',x=>({...x,source:x.source.replace(' && !Array.isArray(value)',''),arrayWitness:true}),'pending'],
 ['nullable witnesses skipped',x=>({...x,tests:x.tests.replace('if(invalid !== null)','if(false)')}),'pending'],
 ['other field masks string rejection',x=>({...x,tests:x.tests.replace('makeGrant({[field]:invalid}),makeQuery()','makeGrant({[field]:invalid}),makeQuery({at:null})')}),'pending'],
 ['assert replacement masks missing source guards',x=>({...x,source:'export function canReuse(grant,query){return true;}',tests:x.tests.replace("test('object", "assert.throws=()=>{}; test('object")}),'pending']
]) test(`cached record fields after actual passing verifier: ${label}`,t=>runCacheReceipt(t,change(cacheFixture()),'Throw `TypeError` for malformed input.',expected));
