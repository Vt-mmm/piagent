import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

// Static evidence fixtures: the contract declares the invalid parameter;
// incidental zero/negative values in another argument do not redefine it.
function evidence({ name = "boundIndex", parameter = "position", parameters = ["position", "totalSize", "chunkSize"],
  calls = ["1.5, 0, 5", "'1', 0, 5"], body, text, binding } = {}) {
  const source = `export function ${name}(${parameters.join(", ")}) { ${body
    ?? `if (!Number.isInteger(${parameter})) throw new TypeError('invalid integer'); return ${parameter};`} }`;
  const tests = `import assert from 'node:assert/strict';\n${binding
    ?? `import { ${name} } from '../src/numeric.js';`}\n`
    + calls.map(args => `assert.throws(() => ${name}(${args}), TypeError);`).join("\n");
  return acceptanceInvalidInputEvidence({
    taskText: text ?? `\`${name}\` must reject a non-integer ${parameter} with \`TypeError\`;`,
    sourceText: source, testText: tests, sourceEntries: [{ path: "src/numeric.js", text: source }],
    testEntries: [{ path: "test/numeric.test.js", text: tests }], namedTargets: [name], provenanceTargets: []
  });
}

test("declared non-integer rejection does not turn another argument's zero into an invalid domain", () => {
  assert.deepEqual(evidence(), { sourceOk: true, testOk: true });
  assert.deepEqual(evidence({ calls: ["1.5, -4, 0", "'1', -4, 0"] }), { sourceOk: true, testOk: true });
});

test("parameter requirements follow names and positions, not a benchmark function or first argument", () => {
  assert.deepEqual(evidence({ name: "limitCursor", parameter: "cursor", parameters: ["totalSize", "cursor", "chunkSize"],
    calls: ["0, 1.5, 5", "0, '1', 5"] }), { sourceOk: true, testOk: true });
});

test("non-finite and missing witnesses do not require rejection of valid negative integers", () => {
  assert.deepEqual(evidence({ calls: ["1.5, 0, 5", "undefined, 0, 5", "Infinity, 0, 5", "-Infinity, 0, 5"] }),
    { sourceOk: true, testOk: true });
});

test("tests on another parameter cannot satisfy the declared integer rejection", () => {
  assert.equal(evidence({ calls: ["1, 1.5, 5", "1, '1', 5"] }).testOk, false);
  for (const spread of ["...[0, 1]", "...[]"]) {
    assert.equal(evidence({ parameters: ["totalSize", "position", "chunkSize"],
      calls: [`${spread}, 1.5, 5`, `${spread}, '1', 5`] }).testOk, false,
    "a syntactic argument index after a spread is not a parameter binding");
  }
});

test("the integer-domain proof cannot be replaced by a fractional-only guard or pre-guard effects", () => {
  for (const body of [
    "if (position % 1 !== 0) throw new TypeError(); return position;",
    "if (position > 0 && !Number.isInteger(position)) throw new TypeError(); return position;",
    "position = 1; if (!Number.isInteger(position)) throw new TypeError(); return position;",
    "if (!Number.isInteger(position)) throw new TypeError(makeMessage()); return position;",
    "const Number = { isInteger: () => true }; if (!Number.isInteger(position)) throw new TypeError(); return position;"
  ]) assert.equal(evidence({ body }).sourceOk, false, body);
  assert.equal(evidence({ parameters: ["position", "totalSize = mutateIntrinsics()", "chunkSize"] }).sourceOk, false);
});

test("the declared input still needs source rejection and actual imported test binding", () => {
  assert.equal(evidence({ body: "return position;" }).sourceOk, false);
  assert.equal(evidence({ body: "if (!Number.isInteger(totalSize)) throw new TypeError(); return position;" }).sourceOk, false);
  assert.equal(evidence({ binding: "import { boundIndex } from '../src/unrelated.js';" }).testOk, false);
});

test("missing or additional contract constraints cannot be silently dropped by parameter binding", () => {
  assert.equal(evidence({ text: "`boundIndex` must reject a non-integer missingParameter with `TypeError`;" }).sourceOk, false);
  assert.equal(evidence({ text: "`boundIndex` must reject a non-integer position and negative totalSize with `TypeError`;",
    calls: ["1.5, 0, 5", "1, -4, 5"] }).sourceOk, false);
});

test("exported-function parameter proof does not disable the separate supported method route", () => {
  const source = "export class Guard {\n boundIndex(position) {\n if (!Number.isInteger(position)) throw new TypeError('integer');\n return position;\n }\n}\n";
  const tests = "import assert from 'node:assert/strict';\nimport { Guard } from '../src/numeric.js';\n"
    + "const guard = new Guard();\nassert.throws(() => guard.boundIndex(1.5), TypeError);\n"
    + "assert.throws(() => guard.boundIndex('1'), TypeError);\n";
  const evaluate = taskText => acceptanceInvalidInputEvidence({ taskText, sourceText: source, testText: tests,
    sourceEntries: [{ path: "src/numeric.js", text: source }], testEntries: [{ path: "test/numeric.test.js", text: tests }],
    namedTargets: ["boundIndex"], provenanceTargets: [] });
  assert.deepEqual(evaluate("The `boundIndex` method must reject a non-integer position with `TypeError`;"),
    { sourceOk: true, testOk: true });
  assert.deepEqual(evaluate("`boundIndex` must reject a non-integer position with `TypeError`;"),
    { sourceOk: true, testOk: true });
});

{
const proof = acceptanceInvalidInputEvidence;
const clause='Reject negative/non-integer amount or quantity inputs with `TypeError`;';
const source='export function total(amount, quantity, tax) { if (!Number.isInteger(amount) || amount < 0) throw new TypeError(); if (!Number.isInteger(quantity) || quantity < 0) throw new TypeError(); return amount * quantity; }';
const calls=['-1,1,0','0.5,1,0','1,-1,0','1,0.5,0'];
const evidence=(text=source,args=calls,criterion=clause)=>{const tests='import assert from "node:assert/strict"; import {total} from "../src/total.js"; '+args.map(x=>`assert.throws(()=>total(${x}),TypeError);`).join('\n');return proof({taskText:criterion,sourceText:text,testText:tests,sourceEntries:[{path:'src/total.js',text}],testEntries:[{path:'test/total.test.js',text:tests}],namedTargets:[],provenanceTargets:[]});};
for(const [label,text,args,sourceOk,testOk] of [
 ['both declared inputs independently guarded',source,calls,true,true],
 ['first declared input lacks witnesses',source,calls.slice(2),true,false],
 ['second declared input lacks witnesses',source,calls.slice(0,2),true,false],
 ['only unrelated input tested',source,['1,1,-1','1,1,0.5'],true,false],
 ['one invalid argument can mask the other',source,['-1,-1,0','0.5,0.5,0'],true,false],
 ['missing negative witnesses',source,['0.5,1,0','1,0.5,0'],true,false],
 ['first declared guard absent',source.replace('if (!Number.isInteger(amount) || amount < 0) throw new TypeError();',''),calls,false,true],
 ['second declared guard absent',source.replace('if (!Number.isInteger(quantity) || quantity < 0) throw new TypeError();',''),calls,false,true],
 ['input rewritten before guard',source.replace('{ if','{ amount = 1; if'),calls,false,true],
 ['conditional guard can suppress rejection',source.replace('!Number.isInteger(amount) || amount < 0','tax && (!Number.isInteger(amount) || amount < 0)'),calls,false,true],
 ['intrinsic shadowed',source.replace('{ if','{ const Number = {isInteger:()=>true}; if'),calls,false,true],
 ['throw message calls unknown code',source.replaceAll('new TypeError()','new TypeError(message())'),calls,false,true],
 ['wrong error class',source.replaceAll('new TypeError()','new RangeError()'),calls,false,true],
 ['early return',source.replace('{ if','{ return 0; if'),calls,false,true],
 ['unresolved requested input',source.replaceAll('amount','price'),calls,false,false],
 ['reordered arguments follow declared names',source.replace('amount, quantity, tax','quantity, tax, amount'),['1,0,-1','1,0,0.5','-1,0,1','0.5,0,1'],true,true]
])test(`compound integer domain: ${label}`,()=>assert.deepEqual(evidence(text,args),{sourceOk,testOk}));
test('and binds the same declared inputs',()=>assert.deepEqual(evidence(source,calls,clause.replace('or','and')),{sourceOk:true,testOk:true}));
test('bounded literal loops reuse current assertion expansion',()=>{
 const tests='import assert from "node:assert/strict"; import {total} from "../src/total.js"; for (const invalid of [-1,0.5]) { assert.throws(()=>total(invalid,1,0),TypeError); assert.throws(()=>total(1,invalid,0),TypeError); }';
 assert.deepEqual(proof({taskText:clause,sourceText:source,testText:tests,sourceEntries:[{path:'src/total.js',text:source}],testEntries:[{path:'test/total.test.js',text:tests}],namedTargets:[],provenanceTargets:[]}),{sourceOk:true,testOk:true});
});

for(const criterion of [clause.replace('negative/non-integer','negative or non-integer'),clause.replace('amount or quantity','`amount` or `quantity`')])test(`equivalent declared domains remain bound: ${criterion}`,()=>assert.deepEqual(evidence(source,calls,criterion),{sourceOk:true,testOk:true}));
for(const criterion of [clause+' Also reject zero.',clause.replace('amount or quantity','amount or amount'),clause.replace('amount or quantity','line.amount or quantity')])test(`unresolved or extra domain constraints remain pending: ${criterion}`,()=>assert.deepEqual(evidence(source,calls,criterion),{sourceOk:false,testOk:false}));
test('a single explicit scalar domain uses the same input binding',()=>{
 const one='export function total(amount, tax) { if (!Number.isInteger(amount) || amount < 0) throw new TypeError(); return amount; }';
 assert.deepEqual(evidence(one,['-1,0','0.5,0'],'Reject negative/non-integer amount input with TypeError;'),{sourceOk:true,testOk:true});
});

}

{
const clause = 'Reject negative/non-integer money or quantity inputs with `TypeError`;';
const context = 'All values are integer cents or basis points. For each item, multiply `priceCents` by the positive integer `quantity` (default 1), then apply the discount.';
const source = `function whole(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('integer');
  return value;
}
export function aggregate(records, rate = 0) {
  if (!Array.isArray(records)) throw new TypeError('array');
  whole(rate, 0, 100);
  const subtotal = records.reduce((sum, item) => {
    const amount = whole(item?.priceCents, 0);
    const count = whole(item?.quantity ?? 1, 1);
    const discount = whole(item?.discountBps ?? 0, 0, 10000);
    return sum + Math.round(amount * count * (10000 - discount) / 10000);
  }, 0);
  return Math.round(subtotal * (100 + rate) / 100);
}`;
const prefix = 'import assert from "node:assert/strict"; import { aggregate } from "../src/order.js"; ';
const body = 'for (const priceCents of [-1, 0.5]) { assert.throws(() => aggregate([{ priceCents, quantity: 1 }]), TypeError); }\n'
  + 'for (const quantity of [-1, 0.5]) { assert.throws(() => aggregate([{ priceCents: 1, quantity }]), TypeError); }';
const check = ({ code = source, tests = prefix + body, prose = context, criterion = clause, named = true, extraSource = [] } = {}) => acceptanceInvalidInputEvidence({
  taskText: criterion, contextText: prose, sourceText: code, testText: tests,
  sourceEntries: [{path:'src/order.js',text:code}, ...extraSource], testEntries:[{path:'test/order.test.js',text:tests}],
  namedTargets:named?['aggregate']:[], provenanceTargets:named?['aggregate']:[]
});
test('per-record integer evidence uses task fields with named and inferred import bindings', () => {
  assert.deepEqual(check(), {sourceOk:true,testOk:true});
  assert.deepEqual(check({named:false}), {sourceOk:true,testOk:true});
});
test('per-record integer names follow task and source rather than fixed function, field or parameter names', () => {
  const replace = value => value.replaceAll('aggregate','tally').replaceAll('records','entries').replaceAll('priceCents','costCents').replaceAll('item','entry').replaceAll('whole','integerValue');
  const code=replace(source),tests=replace(prefix+body),prose=replace(context);
  assert.deepEqual(acceptanceInvalidInputEvidence({taskText:clause,contextText:prose,sourceText:code,testText:tests,
    sourceEntries:[{path:'src/order.js',text:code}],testEntries:[{path:'test/order.test.js',text:tests}],namedTargets:['tally'],provenanceTargets:['tally']}),{sourceOk:true,testOk:true});
});
for (const [label,code] of [
  ['money guard removed',source.replace('whole(item?.priceCents, 0)','item?.priceCents')],
  ['quantity guard removed',source.replace('whole(item?.quantity ?? 1, 1)','(item?.quantity ?? 1)')],
  ['negative values permitted',source.replace('value < minimum','value < -10')],
  ['integer guard absent',source.replace('!Number.isSafeInteger(value) || ','')],
  ['fractional-only guard',source.replace('!Number.isSafeInteger(value)','value % 1 !== 0')],
  ['wrong lower bound',source.replace('whole(item?.priceCents, 0)','whole(item?.priceCents, 1)')],
  ['quantity default changed',source.replace('item?.quantity ?? 1','item?.quantity ?? 2')],
  ['money silently defaulted',source.replace('item?.priceCents','item?.priceCents ?? 0')],
  ['only tax tested in source',source.replace('const amount = whole(item?.priceCents, 0);','const amount = 1;').replace('const count = whole(item?.quantity ?? 1, 1);','const count = 1;')],
  ['collection filtered before validation',source.replace('records.reduce','records.filter(() => false).reduce')],
  ['reducer skips a record',source.replace('const amount =','if (sum) return sum; const amount =')],
  ['return before reducer',source.replace('const subtotal =','return 0; const subtotal =')],
  ['helper rewrites the input',source.replace('if (!Number','value = 1; if (!Number')],
  ['helper changes error class',source.replaceAll('new TypeError','new RangeError')],
  ['helper has dynamic error message',source.replace("new TypeError('integer')",'new TypeError(String(value))')],
  ['intrinsic replaced',source.replace('if (!Number','const Number = {isSafeInteger:()=>true}; if (!Number')],
  ['reducer replaced in source',source.replace('whole(rate, 0, 100);','records.reduce = () => 0; whole(rate, 0, 100);')],
  ['async reducer',source.replace('reduce((sum, item)','reduce(async (sum, item)')],
  ['unknown pre-guard call',source.replace('whole(rate, 0, 100);','prepare(); whole(rate, 0, 100);')],
  ['array argument reassigned',source.replace('whole(rate, 0, 100);','records = []; whole(rate, 0, 100);')],
  ['helper first predicate coerces before checking type',source.replace('!Number.isSafeInteger(value) || value < minimum','value < minimum || !Number.isSafeInteger(value)')]
]) test(`per-record integer source control: ${label}`, () => assert.equal(check({code}).sourceOk,false));
for (const [label,tests] of [
  ['money has no witnesses',prefix+body.slice(body.indexOf('for (const quantity'))],
  ['quantity has no witnesses',prefix+body.slice(0,body.indexOf('for (const quantity'))],
  ['unrelated scalar failures',prefix+'assert.throws(() => aggregate([{priceCents:1,quantity:1}],-1),TypeError); assert.throws(() => aggregate([{priceCents:1,quantity:1}],0.5),TypeError);'],
  ['two invalid fields mask each other',prefix+body.replaceAll('quantity: 1','quantity: -1').replaceAll('priceCents: 1','priceCents: -1')],
  ['invalid scalar masks the record',prefix+body.replaceAll('}]),','}], -1),')],
  ['invalid discount masks the record',prefix+body.replaceAll('quantity: 1','quantity: 1, discountBps: -1').replaceAll('priceCents: 1','priceCents: 1, discountBps: -1')],
  ['wrong property case',prefix+body.replaceAll('priceCents','PriceCents')],
  ['fractional witness absent',prefix+body.replaceAll('[-1, 0.5]','[-1, -2]')],
  ['negative witness absent',prefix+body.replaceAll('[-1, 0.5]','[0.5, 1.5]')],
  ['wrong source import',(prefix+body).replace('../src/order.js','../src/unrelated.js')],
  ['wrong error class',prefix+body.replaceAll('TypeError','RangeError')],
  ['dead assertions',prefix+body.replaceAll('assert.throws','if (false) assert.throws')],
  ['property spread can override the value',prefix+body.replaceAll('quantity: 1','quantity: 1, ...{priceCents: -1}')],
  ['duplicate property can override the value',prefix+body.replaceAll('quantity: 1','quantity: 1, priceCents: -1')],
  ['native reducer replaced through alias',prefix+'const borrowed = Array; borrowed.prototype.reduce = () => { throw new TypeError(); };'+body],
  ['native reducer replaced by test',prefix+'Array.prototype.reduce = () => { throw new TypeError(); };'+body],
  ['Number predicate replaced by test',prefix+'Number.isSafeInteger = () => false;'+body],
  ['test binding shadowed',prefix+'const aggregate = () => { throw new TypeError(); };'+body]
]) test(`per-record integer witness control: ${label}`, () => assert.equal(check({tests}).testOk,false));
for (const [label,prose,criterion=clause] of [
  ['missing context',''],
  ['missing units',context.replace('All values are integer cents or basis points. ','')],
  ['wrong field binding',context.replace('priceCents','otherCents')],
  ['ambiguous related record',context+' For each item, multiply `otherCents` by the positive integer `quantity` (default 1)'],
  ['incompatible default',context.replace('default 1','default 2')],
  ['additional selected obligation',context,clause+' Also reject negative fees.'],
  ['unresolved selected input',context,clause.replace('quantity','count')]
]) test(`per-record integer context control: ${label}`, () => assert.deepEqual(check({prose,criterion}),{sourceOk:false,testOk:false}));
test('other source modules cannot replace the numeric environment', () => {
  assert.equal(check({extraSource:[{path:'src/poison.js',text:'Number.isSafeInteger = () => false;'}]}).sourceOk,false);
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
function intervalEvidence(options = {}) { return acceptanceInvalidInputEvidence(intervalFixture(options)); }
for (const inferred of [false, true]) {
  const route = inferred ? 'inferred' : 'named';
  test(`finite interval ${route}: original generic field matrix establishes rejection`, () => {
    assert.deepEqual(intervalEvidence({inferred}), {sourceOk:true,testOk:true});
  });
  for (const field of ['packet.stamp', 'packet.receipt', 'frame.lo', 'frame.hi', 'frame.tolerance']) {
    test(`finite interval ${route}: source must validate ${field}`, () => {
      const source=intervalFixture().sourceText.replace(field === 'frame.tolerance' ? ', '+field+'].every' : field+', ', field === 'frame.tolerance' ? '].every' : '');
      assert.notEqual(source,intervalFixture().sourceText);
      assert.equal(intervalEvidence({source,inferred}).sourceOk,false);
    });
  }
  for (const [label,before,after] of [
    ['finite only','Number.isFinite(value) && Number.isInteger(value)','Number.isFinite(value)'],
    ['integer-or-finite','Number.isFinite(value) && Number.isInteger(value)','Number.isFinite(value) || Number.isInteger(value)'],
    ['missing skew bound','frame.tolerance < 0','false'],
    ['missing period order','frame.lo >= frame.hi','false'],
    ['equal period admitted','frame.lo >= frame.hi','frame.lo > frame.hi'],
    ['wrong error class',"new TypeError('invalid interval')","new RangeError('invalid interval')"],
    ['over-restricted domain','Number.isInteger(value)','Number.isSafeInteger(value)'],
    ['wrong receiver','packet.receipt,','frame.receipt,'],
    ['guard after return',"  if (!packet", "  return 'current'; if (!packet"],
    ['array predicate replaced','].every(whole)','].some(whole)'],
    ['native mutation',"function whole(value)","function whole(value)"],
  ]) test(`finite interval ${route}: ${label} cannot supply source proof`,()=>{
    let source=intervalFixture().sourceText.replace(before,after);
    if(label === 'native mutation') source+='\nNumber.isInteger = () => true;';
    assert.equal(intervalEvidence({source,inferred}).sourceOk,false);
  });
  for (const field of ['stamp','receipt','lo','hi','tolerance']) test(`finite interval ${route}: missing ${field} witnesses cannot be borrowed`,()=>{
    const tests=intervalFixture().testText.replace("'"+field+"', ",'').replace(", '"+field+"'",'');
    assert.notEqual(tests,intervalFixture().testText);
    assert.equal(intervalEvidence({tests,inferred}).testOk,false);
  });
  for (const [label,before,after] of [
    ['wrong source import',"../src/interval.js","../src/other.js"],
    ['skipped test',"test('typed", "test.skip('typed"],
    ['early return',"test('typed fields and interval relations', () => {", "test('typed fields and interval relations', () => { return;"],
    ['skipped iteration',"for (const field of ['stamp', 'receipt']) assert.throws", "for (const field of ['stamp', 'receipt']) if (false) assert.throws"],
    ['non-native assert',"node:assert/strict","./fake-assert.js"],
    ['non-native runner',"node:test","./fake-test.js"],
    ['factory aliases',"classifyArrival(sample({ [field]: invalid }), range())","classifyArrival(copied({ [field]: invalid }), range())"],
    ['factory changes overwritten',"stamp: 10, receipt: 10, ...changes","...changes, stamp: 10, receipt: 10"],
    ['effectful factory',"({ stamp: 10, receipt: 10, ...changes })","({ stamp: touch(), receipt: 10, ...changes })"],
    ['mutable factory',"const sample =", "let sample ="],
    ['parameter masks invalid field',"sample({ [field]: invalid }), range()","sample({ [field]: invalid }), range({ tolerance: -1 })"],
    ['absent negative skew',"  assert.throws(() => classifyArrival(sample(), range({ tolerance: -1 })), TypeError);",''],
    ['absent equal period',"  assert.throws(() => classifyArrival(sample(), range({ hi: 10 })), TypeError);",''],
    ['absent reversed period',"  assert.throws(() => classifyArrival(sample(), range({ hi: 9 })), TypeError);",''],
    ['nested scalar factory',"classifyArrival(invalid, range())","classifyArrival(sample({ stamp: invalid }), range())"],
    ['masked whole-object rejection',"classifyArrival(invalid, range())","classifyArrival(invalid, range({ tolerance: -1 }))"],
  ]) test(`finite interval ${route}: ${label} does not establish test coverage`,()=>{
    const tests=intervalFixture().testText.replace(before,after);
    assert.notEqual(tests,intervalFixture().testText);
    assert.equal(intervalEvidence({tests,inferred}).testOk,false);
  });
  test(`finite interval ${route}: aliases of Array cannot replace the iteration predicate`,()=>{
    const tests=intervalFixture().testText.replace("test('typed", "const nativeArray = Array; nativeArray.prototype.every = () => { throw new TypeError(); };\ntest('typed");
    assert.equal(intervalEvidence({tests,inferred}).testOk,false);
  });
  test(`finite interval ${route}: global window is still unavailable`,()=>{
    const tests=intervalFixture().testText.replace("test('typed", "window.receipt = 10;\ntest('typed");
    assert.equal(intervalEvidence({tests,inferred}).testOk,false);
  });
  test(`finite interval ${route}: local window data is not a browser-global reference`,()=>{
    const tests=intervalFixture().testText+"\ntest('local snapshot', () => { const window = range(); assert.deepEqual(window, range()); });";
    assert.deepEqual(intervalEvidence({tests,inferred}),{sourceOk:true,testOk:true});
  });
  test(`finite interval ${route}: field/function renaming follows the declared context`,()=>{
    let fixture=JSON.stringify(intervalFixture({inferred}));
    for(const [from,to] of [['classifyArrival','routeReceipt'],['stamp','emitted'],['receipt','arrived'],['tolerance','allowance'],['packet','record'],['frame','interval']]) fixture=fixture.replace(new RegExp('\\b'+from+'\\b','g'),to);
    assert.deepEqual(acceptanceInvalidInputEvidence(JSON.parse(fixture)),{sourceOk:true,testOk:true});
  });
  for(const extra of [' Preserve `other(left, right)`.',' Use `begin <= stamp < finish`.']) test(`finite interval ${route}: ambiguous context ${extra} abstains`,()=>{
    const result=intervalEvidence({context:intervalFixture().contextText+extra,inferred});
    assert.equal(result.sourceOk,false); assert.equal(result.testOk,false);
  });
}

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
function cacheEvidence(options={}) { return acceptanceInvalidInputEvidence(cacheFixture(options).input); }
for (const inferred of [false,true]) {
 const route=inferred?'inferred':'named';
 test(`cached records ${route}: all declared string finite and nullable fields`,()=>assert.deepEqual(cacheEvidence({inferred}),{sourceOk:true,testOk:true}));
 for(const member of ['grant.teamId','grant.subjectId','grant.action','query.teamId','query.subjectId','query.action','grant.policyRevision','grant.evaluationTime','grant.until','query.currentPolicyRevision','query.at']) {
  test(`cached records ${route}: missing ${member} guard`,()=>{
   const original=cacheFixture().source;
   const source=original.replace(member+', ','').replace(', '+member+'].every','].every');
   assert.notEqual(source,original);assert.equal(cacheEvidence({source,inferred}).sourceOk,false);
  });
 }
 for(const [label,before,after] of [
  ['arrays admitted'," && !Array.isArray(value)",''],['empty ids admitted','value.length > 0','value.length >= 0'],
  ['finite only','Number.isFinite(value) && Number.isInteger(value)','Number.isFinite(value)'],
  ['coercive string predicate',"typeof value === 'string' &&","typeof value === 'string' ||"],
  ['nullable guard absent','(query.revocation !== null && !whole(query.revocation))','false'],
  ['nullable validator on other field','!whole(query.revocation)','!whole(query.at)'],
  ['null treated as malformed','query.revocation !== null && !whole(query.revocation)','!whole(query.revocation)'],
  ['wrong error class',"new TypeError('invalid grant')","new RangeError('invalid grant')"],
  ['wrong revision operand','grant.policyRevision === query.currentPolicyRevision','grant.policyRevision === query.at'],
  ['wrong evaluation receiver','grant.evaluationTime <= query.at','query.evaluationTime <= query.at'],
  ['wrong expiry boundary','query.at < grant.until','query.at <= grant.until'],
  ['wrong revocation boundary','query.revocation <= query.at','query.revocation < query.at'],
  ['native predicate replaced','function whole(value)','function whole(value)'],
 ]) test(`cached records ${route}: ${label}`,()=>{
  let source=cacheFixture().source.replace(before,after);if(label==='native predicate replaced')source+='\nNumber.isInteger = () => true;';
  assert.equal(cacheEvidence({source,inferred}).sourceOk,false);
 });
 for(const field of ['teamId','subjectId','action','policyRevision','evaluationTime','until','currentPolicyRevision','at']) test(`cached records ${route}: missing ${field} witness`,()=>{
  const original=cacheFixture().tests,tests=original.replace("'"+field+"',",'').replace(",'"+field+"'",'');
  assert.notEqual(tests,original);assert.equal(cacheEvidence({tests,inferred}).testOk,false);
 });
 for(const [label,before,after] of [
  ['nullable witnesses absent','if(invalid !== null) assert.throws(()=>canReuse(makeGrant(),makeQuery({revocation:invalid})),TypeError);',''],
  ['nullable conditional reversed','if(invalid !== null)','if(invalid === null)'],
  ['empty strings absent',"['',null,1,undefined]","[null,1,undefined]"],
  ['fractional witnesses absent',',0.25,',','],['non-finite witnesses absent','NaN,Infinity,-Infinity,',''],
  ['object arrays absent','null,undefined,[],1','null,undefined,1'],
  ['other input masks field','makeGrant({[field]:invalid}),makeQuery()','makeGrant({[field]:invalid}),makeQuery({at:null})'],
  ['nullable marker masks nullable field','makeGrant(),makeQuery({revocation:invalid})','makeGrant({teamId:\'\'}),makeQuery({revocation:invalid})'],
  ['dead nullable branch','if(invalid !== null)','if(false)'],
  ['helper mutation of sample','teamId:\'north\',subjectId','teamId:touch(),subjectId'],
  ['skipped field test',"test('object", "test.skip('object"],
  ['wrong target import','../src/grant.js','../src/other.js']
 ]) test(`cached records ${route}: ${label} cannot supply tests`,()=>{
  const tests=cacheFixture().tests.replace(before,after);assert.notEqual(tests,cacheFixture().tests);assert.equal(cacheEvidence({tests,inferred}).testOk,false);
 });
 test(`cached records ${route}: identifiers follow renamed context and source`,()=>{
  let value=JSON.stringify(cacheFixture({inferred}).input);
  for(const [from,to] of [['canReuse','mayUse'],['grant','cachedGrant'],['query','currentQuery'],['team','organization'],['teamId','organizationId'],['policy','permission'],['policyRevision','permissionRevision'],['currentPolicyRevision','currentPermissionRevision'],['evaluationTime','evaluatedAt']]) value=value.replace(new RegExp('\\b'+from+'\\b','g'),to);
  assert.deepEqual(acceptanceInvalidInputEvidence(JSON.parse(value)),{sourceOk:true,testOk:true});
 });
 test(`cached records ${route}: conflicting declared time owner abstains`,()=>{
  const context=cacheFixture().context+' `other.at` is strictly before `cached.until`.';
  assert.deepEqual(cacheEvidence({context,inferred}),{sourceOk:false,testOk:false});
 });
}

import fsGraph from 'node:fs';import osGraph from 'node:os';import pathGraph from 'node:path';import cryptoGraph from 'node:crypto';import {spawnSync as spawnGraph} from 'node:child_process';
import {buildAcceptanceReceipt as buildGraphReceipt,refreshAcceptanceReceipt as refreshGraphReceipt} from '../packages/piagent-core/extensions/acceptance-receipt.js';
import {compileCriterionGraph as compileGraphCriteria} from '../packages/piagent-core/extensions/criterion-graph.js';
import {versionWorkingTreeHash as graphTreeHash} from '../packages/piagent-core/extensions/working-tree-digest.js';
import {nativeErrorReferencesAreUnshadowed} from '../packages/piagent-core/extensions/acceptance-local-binding.js';
for(const [label,raw,names,wanted]of [
 ['lowercase callback data',"assert.throws(()=>run(),error=>error instanceof Error && error.message.includes('cycle'));",['error'],true],
 ['unrelated lowercase declaration',"const error='value';throw new Error(error);",['error'],true],
 ['case-distinct local function',"function error(value){return value;}throw new Error('cycle');",['error'],true],
 ['different callback name',"assert.throws(()=>run(),failure=>failure instanceof Error);",['error'],true],
 ['direct constructor assertion',"assert.throws(()=>run(),TypeError);",['typeerror'],true],
 ['multiple classes',"new TypeError();new RangeError();",['typeerror','rangeerror'],true],
 ['constructor parameter',"function f(Error){throw new Error();}",['error'],false],
 ['constructor callback',"assert.throws(()=>run(),Error=>Error instanceof Error);",['error'],false],
 ['constructor destructured parameter',"function f({Error}){throw new Error();}",['error'],false],
 ['constructor class binding',"class Error{};throw new Error();",['error'],false],
 ['constructor function binding',"function Error(){};throw new Error();",['error'],false],
 ['constructor variable',"const Error=Other;throw new Error();",['error'],false],
 ['constructor import',"import {Error} from 'x';throw new Error();",['error'],false],
 ['constructor catch binding',"try{run()}catch(Error){throw new Error();}",['error'],false],
 ['constructor assignment',"Error=Other;throw new Error();",['error'],false],
 ['constructor destructured write',"({Error}=value);throw new Error();",['error'],false],
 ['constructor alias',"const Alias=Error;throw new Alias();",['error'],false],
 ['constructor escape',"use(Error);throw new Error();",['error'],false],
 ['constructor property write',"Error.extra=true;throw new Error();",['error'],false],
 ['constructor prototype write',"Error.prototype.extra=true;throw new Error();",['error'],false],
 ['global constructor replacement',"globalThis.Error=Other;throw new Error();",['error'],false],
 ['reflective replacement',"Reflect.set(globalThis,'Error',Other);throw new Error();",['error'],false],
 ['property replacement',"Object.defineProperty(Error,'x',{value:1});throw new Error();",['error'],false],
 ['computed property lookup',"obj['Error']=Other;throw new Error();",['error'],false],
 ['unobserved constructor',"const error=1;",['error'],false],
 ['wrong case is no native use',"throw new error();",['error'],false],
 ['lowercase constructor beside real native use',"new Error();new error();",['error'],false],
 ['uppercase constructor beside real native use',"new Error();new ERROR();",['error'],false],
 ['lowercase typed constructor beside native use',"new TypeError();new typeerror();",['typeerror'],false],
 ['lowercase factory call beside native use',"new Error();const error=()=>({});throw error();",['error'],false],
 ['lowercase instanceof beside native use',"new Error();value instanceof error;",['error'],false],
 ['case-folded expected constructor identifier',"new Error();assert.throws(()=>run(),error);",['error'],false],
 ['optional computed constructor reflection',"fn?.['constructor']('change')();new Error();",['error'],false],
 ['missing requested class',"throw new Error();",['error','typeerror'],false],
 ['unknown requested class',"throw new Error();",['madeup'],false],
 ['invalid syntax',"throw new Error(",['error'],false],
 ['oversized input',' '.repeat(64001)+'new Error()', ['error'],false]
])test(`case-preserving native error identity: ${label}`,()=>assert.equal(nativeErrorReferencesAreUnshadowed(raw,names),wanted));
function graphFixture(){return {source:`export function orderItems(items){
 const index=new Map(items.map(entry=>[entry.key,entry]));const state=new Map();const result=[];
 function visit(key){if(state.get(key)===1)throw new Error('dependency cycle');if(state.get(key)===2)return;state.set(key,1);for(const edge of index.get(key)?.needs??[])if(index.has(edge))visit(edge);state.set(key,2);result.push(key);}
 for(const entry of items)visit(entry.key);return result;
}`,tests:`import assert from 'node:assert/strict';import test from 'node:test';import {orderItems} from '../src/graph.js';
test('success respects edge order',()=>{const input=[{key:'app',needs:['lib']},{key:'lib'}];const result=orderItems(input);assert.deepEqual(result,['lib','app']);});
test('self and indirect cycles',()=>{for(const input of [[{key:'self',needs:['self']}],[{key:'a',needs:['b']},{key:'b',needs:['c']},{key:'c',needs:['a']}]]){const before=structuredClone(input);assert.throws(()=>orderItems(input),error=>error instanceof Error&&error.message.includes('cycle'));assert.deepEqual(input,before);}});
test('frozen success',()=>{const input=Object.freeze([Object.freeze({key:'app',needs:Object.freeze(['lib'])}),Object.freeze({key:'lib'})]);const before=structuredClone(input);assert.deepEqual(orderItems(input),['lib','app']);assert.deepEqual(input,before);});`,criteria:['Throw an `Error` containing `cycle` when an in-repository cycle exists.','Do not mutate input.']};}
function checkGraphReceipt(t,fixture,wanted){
 const cwd=fsGraph.mkdtempSync(pathGraph.join(osGraph.tmpdir(),'piagent-graph-proof-'));t.after(()=>fsGraph.rmSync(cwd,{recursive:true,force:true}));
 const scope=['src/graph.js','test/graph.test.js'],command='node --test test/graph.test.js';fsGraph.writeFileSync(pathGraph.join(cwd,'package.json'),'{"type":"module"}');
 for(const [name,text]of [[scope[0],fixture.source],[scope[1],fixture.tests]]){const file=pathGraph.join(cwd,name);fsGraph.mkdirSync(pathGraph.dirname(file),{recursive:true});fsGraph.writeFileSync(file,text);}
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
 const run=spawnGraph(process.execPath,['--test','--test-reporter=tap',scope[1]],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);
 if(fixture.witness){const run=spawnGraph(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {orderItems} from './src/graph.js';"+fixture.witness],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);}
 const expectedOutput='Order graph nodes once, with internal dependencies before their dependents. '+fixture.criteria.join(' '),summary='Order dependency records.';
 const built=buildGraphReceipt({summary,expectedOutput,acceptanceCriteria:fixture.criteria,changeMode:'source-change',source:'runtime'}),digest=graphTreeHash(cryptoGraph.createHash('sha256').update(fixture.source).update(fixture.tests).digest('hex'));
 const task={...built,summary,expectedOutput,acceptanceReceipt:built.receipt,scope,criterionGraph:compileGraphCriteria({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
 const refresh=value=>refreshGraphReceipt(value,{cwd,currentWorkingTreeDigest:digest}).receipt.criteria.slice(0,2).map(x=>x.status);
 assert.deepEqual(refresh(task),wanted);
 if(wanted.includes('satisfied'))for(const other of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},{...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:graphTreeHash('a'.repeat(64))}]}])assert.deepEqual(refresh(other),['pending','pending']);
}
const graphGood=['satisfied','satisfied'],graphBad=['pending','pending'];
for(const [label,change,wanted]of [
 ['native recursive maps with actual mutable and cycle witnesses',x=>x,graphGood],
 ['renamed callable and source fields',x=>({...x,source:x.source.replaceAll('orderItems','arrange').replaceAll('key','label').replaceAll('needs','links'),tests:x.tests.replaceAll('orderItems','arrange').replaceAll('key','label').replaceAll('needs','links')}),graphGood],
 ['renamed source import alias',x=>({...x,tests:x.tests.replace('import {orderItems}','import {orderItems as arrange}').replaceAll('orderItems(','arrange(')}),graphGood],
 ['renamed assertion import retains unsupported generic behavior profile',x=>({...x,tests:x.tests.replace('import assert','import check').replaceAll('assert.','check.')}),['satisfied','pending']],
 ['case-distinct callback identifier',x=>({...x,tests:x.tests.replaceAll('error','failure')}),graphGood],
 ['strict deep comparisons',x=>({...x,tests:x.tests.replaceAll('deepEqual','deepStrictEqual')}),graphGood],
 ['missed two-node cycle despite passing samples',x=>({...x,source:x.source.replace("if(state.get(key)===1)throw new Error('dependency cycle');","if(state.get(key)===1){if(items.length===1||items.length===3)throw new Error('dependency cycle');return;}"),witness:"assert.deepEqual(orderItems([{key:'a',needs:['b']},{key:'b',needs:['a']}]),['b','a']);"}),graphBad],
 ['unfrozen successful input mutation',x=>({...x,source:x.source.replace('return result;','if(!Object.isFrozen(items)&&items.length)items[0].observed=true;return result;'),witness:"const input=[{key:'a'}];orderItems(input);assert.equal(input[0].observed,true);"}),graphBad],
 ['input write and restore',x=>({...x,source:x.source.replace(' const index='," if(!Object.isFrozen(items)){items.push({key:'temporary'});items.pop();}const index=")}),graphBad],
 ['input field write and restore',x=>({...x,source:x.source.replace('return result;','if(!Object.isFrozen(items)&&items.length){items[0].extra=true;delete items[0].extra;}return result;')}),graphBad],
 ['conditional active mark',x=>({...x,source:x.source.replace('state.set(key,1);','if(items.length!==777)state.set(key,1);')}),graphBad],
 ['conditional complete mark',x=>({...x,source:x.source.replace('state.set(key,2);','state.set(key,items.length===777?1:2);')}),graphBad],
 ['conditional completed-node guard',x=>({...x,source:x.source.replace('if(state.get(key)===2)','if(items.length!==777&&state.get(key)===2)')}),graphBad],
 ['unknown wrapper around recursive call',x=>({...x,source:'function same(x){return x;}\n'+x.source.replace('visit(edge);','visit(same(edge));')}),graphBad],
 ['unknown source branch',x=>({...x,source:x.source.replace(' const index='," if(items.length===777)return [];const index=")}),graphBad],
 ['different recursive alias',x=>({...x,source:x.source.replace('for(const entry of items)','const invoke=visit;for(const entry of items)').replace('visit(entry.key)','invoke(entry.key)')}),graphBad],
 ['native map alias',x=>({...x,source:'const NativeMap=Map;\n'+x.source.replaceAll('new Map','new NativeMap')}),graphBad],
 ['native map shadow',x=>({...x,source:x.source.replace(' const index=',' const Map=globalThis.Map;const index=')}),graphBad],
 ['only self-cycle tested',x=>({...x,tests:x.tests.replace(",[{key:'a',needs:['b']},{key:'b',needs:['c']},{key:'c',needs:['a']}]",'')}),['pending','satisfied']],
 ['only indirect cycle tested',x=>({...x,tests:x.tests.replace("[{key:'self',needs:['self']}],",'')}),['pending','satisfied']],
 ['frozen-only successful input',x=>({...x,tests:x.tests.replace("const input=[{key:'app',needs:['lib']},{key:'lib'}];","const input=Object.freeze([{key:'app',needs:['lib']},{key:'lib'}]);")}),['satisfied','pending']],
 ['snapshot compared to itself',x=>({...x,tests:x.tests.replaceAll('assert.deepEqual(input,before)','assert.deepEqual(before,before)')}),['satisfied','pending']],
 ['wrong snapshot target',x=>({...x,tests:x.tests.replaceAll('structuredClone(input)','structuredClone([])').replaceAll('assert.deepEqual(input,before)','assert.deepEqual([],before)')}),graphBad],
 ['cycle registration skipped',x=>({...x,tests:x.tests.replace("test('self", "test.skip('self")}),graphBad],
 ['cycle registration unreachable',x=>({...x,tests:x.tests.replace("test('self", "if(false)test('self")}),graphBad],
 ['cycle loop unreachable',x=>({...x,tests:x.tests.replace('for(const input of','if(false)for(const input of')}),graphBad],
 ['callback returns before target',x=>({...x,tests:x.tests.replace('()=>orderItems(input),error',"()=>{throw new Error('cycle');orderItems(input);},error")}),graphBad],
 ['predicate always true',x=>({...x,tests:x.tests.replace("error=>error instanceof Error&&error.message.includes('cycle')","error=>true")}),graphBad],
 ['predicate does not check message',x=>({...x,tests:x.tests.replace("&&error.message.includes('cycle')",'')}),graphBad],
 ['assertion replaced',x=>({...x,tests:x.tests.replace("test('self", "assert.throws=()=>{};test('self")}),graphBad],
 ['source result not asserted',x=>({...x,tests:x.tests.replace("assert.deepEqual(result,['lib','app'])","assert.deepEqual(['lib','app'],['lib','app'])").replace("assert.deepEqual(orderItems(input),['lib','app'])","assert.deepEqual(['lib','app'],['lib','app'])")}),['satisfied','pending']],
 ['snapshot taken after rejection',x=>({...x,tests:x.tests.replace("const before=structuredClone(input);assert.throws(()=>orderItems(input),error=>error instanceof Error&&error.message.includes('cycle'));","assert.throws(()=>orderItems(input),error=>error instanceof Error&&error.message.includes('cycle'));const before=structuredClone(input);")}),['satisfied','pending']],
 ['successful input alias cannot hide frozen provenance',x=>({...x,tests:x.tests.replace("const result=orderItems(input);","const alias=Object.freeze(input);const result=orderItems(input);")}),['satisfied','pending']],
 ['extra cycle requirement retained',x=>({...x,criteria:[x.criteria[0]+' Also reject duplicate node names.',x.criteria[1]]}),['pending','satisfied']]
])test(`dependency graph proof after real verifier: ${label}`,t=>checkGraphReceipt(t,change(graphFixture()),wanted));
