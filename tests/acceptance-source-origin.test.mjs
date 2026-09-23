import assert from "node:assert/strict";
import test from "node:test";
import { routeNamedSourceTargets } from "../packages/piagent-core/extensions/acceptance-source-origin.js";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

const target = "requireinteger", module = "src/number.mjs";
const correct = "export function requireInteger(value) { if (!Number.isInteger(value)) throw new TypeError('integer'); return value; }\n";
const exported = { contractName: target, exportName: target, sourceName: target, sourcePath: module };
const directTest = "import assert from 'node:assert/strict'; import { requireInteger } from '../src/number.mjs'; assert.throws(() => requireInteger(1.5), TypeError);";
const request = "`requireInteger` must throw `TypeError` for fractional input.";
function route(sources = [{ path: module, text: correct }], overrides = {}) {
  return routeNamedSourceTargets({ namedTargets: [target], provenanceTargets: new Set(),
    sourceEntries: sources, exports: [exported], taskText: request, ...overrides });
}

test("an origin records exact spelling, module and span without granting behavior proof", () => {
  const result = route();
  assert.deepEqual(result.strictTargets, [target]);
  assert.deepEqual(result.structuralTargets, []);
  assert.deepEqual(result.unresolvedTargets, []);
  const origin = result.routes[0].origin;
  assert.equal(origin.name, "requireInteger");
  assert.equal(origin.path, module);
  assert.equal(origin.kind, "function");
  assert.equal(origin.topLevel, true);
  assert.equal(correct.slice(origin.start, origin.end), correct.slice("export ".length).trim());
  const wrong = "export function requireInteger(value) { return value; }";
  assert.deepEqual(route([{ path: module, text: wrong }]).strictTargets, [target]);
  assert.deepEqual(acceptanceInvalidInputEvidence({ taskText: request, sourceText: wrong, testText: directTest,
    sourceEntries: [{ path: module, text: wrong }], testEntries: [{ path: "test/number.test.mjs", text: directTest }],
    namedTargets: ["requireInteger"], provenanceTargets: [] }), { sourceOk: false, testOk: true });
});

for (const [name, competing] of [
  ["inline class method", "export class Guard { requireInteger(value) { return value; } }"],
  ["multiline class method", "export class Guard {\n requireInteger(value) { return value; }\n}"],
  ["static class method", "export class Guard { static requireInteger(value) { return value; } }"],
  ["private class method", "export class Guard { #requireInteger(value) { return value; } }"],
  ["getter", "export class Guard { get requireInteger() { return 1; } }"],
  ["setter", "export class Guard { set requireInteger(value) {} }"],
  ["computed string method", "export class Guard { ['requireInteger'](value) { return value; } }"],
  ["computed dynamic method", "const key = 'requireInteger'; export class Guard { [key](value) { return value; } }"],
  ["object method", "export const guard = { requireInteger(value) { return value; } };"],
  ["computed object method", "export const guard = { ['requireInteger'](value) { return value; } };"],
  ["object function property", "export const guard = { requireInteger: function(value) { return value; } };"],
  ["object arrow property", "export const guard = { requireInteger: value => value };"],
  ["class arrow field", "export class Guard { requireInteger = value => value; }"],
  ["class function field", "export class Guard { requireInteger = function(value) { return value; }; }"],
  ["private arrow field", "export class Guard { #requireInteger = value => value; }"],
  ["nested function", "export function factory() { function requireInteger(value) { return value; } return requireInteger; }"],
  ["named returned function", "export function factory() { return function requireInteger(value) { return value; }; }"],
  ["named expression under another binding", "const wrapper = function requireInteger(value) { return value; };"],
  ["case-fold collision", "export function RequireInteger(value) { return value; }"],
  ["escaped identifier collision", String.raw`function factory() { function require\u0049nteger(value) { return value; } }`],
  ["export star with unknown origin", "export * from './other.mjs';"],
  ["malformed code", "export function requireInteger("],
  ["unsupported decorator", "@decorate export class Guard { requireInteger(value) { return value; } }"],
  ["source-size bound", " ".repeat(64_001)]
]) {
  test(`source-origin routing rejects ${name} ambiguity in either layout`, () => {
    for (const sources of [
      [{ path: module, text: correct + competing }],
      [{ path: module, text: correct }, { path: "src/guard.mjs", text: competing }]
    ]) {
      const result = route(sources);
      assert.deepEqual(result.strictTargets, []);
      assert.deepEqual(result.structuralTargets, []);
      assert.deepEqual(result.unresolvedTargets, [target]);
    }
  });
}

test("a sole legitimate structural method retains its route and executable evidence", () => {
  const source = "export class Guard {\n requireInteger(value) { if (!Number.isInteger(value)) throw new TypeError('integer'); return value; }\n}\n";
  const text = "import assert from 'node:assert/strict'; import { Guard } from '../src/number.mjs'; const guard = new Guard(); assert.throws(() => guard.requireInteger(1.5), TypeError);";
  assert.deepEqual(route([{ path: module, text: source }], { exports: [] }).structuralTargets, [target]);
  assert.deepEqual(acceptanceInvalidInputEvidence({ taskText: request, sourceText: source, testText: text,
    sourceEntries: [{ path: module, text: source }], testEntries: [{ path: "test/number.test.mjs", text }],
    namedTargets: ["requireInteger"], provenanceTargets: [] }), { sourceOk: true, testOk: true });
});

test("an explicit requested module cannot borrow the only export from another module", () => {
  const result = route([{ path: "src/other.mjs", text: correct }], {
    exports: [{ ...exported, sourcePath: "src/other.mjs" }], taskText: "`requireInteger` in `src/number.mjs` must throw TypeError for fractional input."
  });
  assert.equal(result.routes[0].reason, "criterion-module-mismatch");
  assert.deepEqual(result.unresolvedTargets, [target]);
});

test("export alias identity stays linked to its actual local callable", () => {
  const text = correct.replace("export function requireInteger", "function check") + "export { check as requireInteger };";
  const result = route([{ path: module, text }], { exports: [{ ...exported, sourceName: "check" }] });
  assert.deepEqual(result.strictTargets, [target]);
  assert.equal(result.routes[0].origin.name, "check");
  const conflicting = route([{ path: module, text: text + "function requireInteger(value) { return value; }" }],
    { exports: [{ ...exported, sourceName: "check" }] });
  assert.deepEqual(conflicting.unresolvedTargets, [target]);
});

test("unrelated names, comments, strings and alias references do not invent declarations", () => {
  const extra = "export function other(value) { return value; }\n// function requireInteger() {}\nconst text = 'requireInteger() {}';\nconst box = { requireInteger };\n";
  assert.deepEqual(route([{ path: module, text: correct + extra }]).strictTargets, [target]);
  const commonjs = correct.replace("export function", "function") + "module.exports = { requireInteger };";
  assert.deepEqual(route([{ path: module, text: commonjs }]).strictTargets, [target]);
});

test("TypeScript syntax is parsed without treating overload signatures as implementations", () => {
  const tsModule = "src/number.ts";
  const typed = correct.replace("(value)", "(value: number): number");
  assert.deepEqual(route([{ path: tsModule, text: typed }], { exports: [{ ...exported, sourcePath: tsModule }] }).strictTargets, [target]);
  assert.deepEqual(route([{ path: tsModule, text: "export function requireInteger(value: string): number;\n" + typed }],
    { exports: [{ ...exported, sourcePath: tsModule }] }).unresolvedTargets, [target]);
});

test("cached origin inventories remain content-bound, path-neutral and immutable", () => {
  const first = route();
  first.routes[0].origin.name = "decoy";
  assert.equal(route().routes[0].origin.name, "requireInteger");
  assert.deepEqual(route([{ path: module, text: correct + "function nested() { function requireInteger() {} }" }]).unresolvedTargets, [target]);
  assert.deepEqual(route([{ path: module, text: correct }, { path: "src/other.mjs", text: correct }]).unresolvedTargets, [target]);
});

for (const alias of [
  "export const guard = { requireInteger: passthrough };",
  "export const guard = { ['requireInteger']: passthrough };",
  "export const guard = {}; guard.requireInteger = passthrough;"
]) test(`method alias cannot borrow another function: ${alias}`, () => {
  const source = "function passthrough(value) { return value; }\n" + alias + "\n" + correct;
  const result = acceptanceInvalidInputEvidence({
    taskText: "The `requireInteger` method in `src/number.mjs` must throw TypeError for fractional input.",
    sourceText: source, testText: directTest, sourceEntries: [{ path: module, text: source }],
    testEntries: [{ path: "test/number.test.mjs", text: directTest }], namedTargets: ["requireInteger"], provenanceTargets: [] });
  assert.deepEqual(result, { sourceOk: false, testOk: false });
});

for (const taskText of [
  "requireInteger in src/actual.mjs must throw TypeError for fractional input.",
  'requireInteger in "src/actual.mjs" must throw TypeError for fractional input.',
  "`requireInteger` in `src/actual.mjs` must throw TypeError for fractional input. Consult `src/number.mjs` for style only."
]) test(`all path quoting forms preserve module constraints: ${taskText}`, () => {
  const result = acceptanceInvalidInputEvidence({ taskText, sourceText: correct, testText: directTest,
    sourceEntries: [{ path: module, text: correct }], testEntries: [{ path: "test/number.test.mjs", text: directTest }],
    namedTargets: ["requireInteger"], provenanceTargets: [] });
  assert.deepEqual(result, { sourceOk: false, testOk: false });
});

test("a re-export never owns an unrelated same-named local implementation", () => {
  const source = correct.replace("export function requireInteger", "function validate")
    + "export { validate as requireInteger } from './wrong.mjs';";
  const wrong = "export function validate(value) { return value; }";
  const result = acceptanceInvalidInputEvidence({
    taskText: "`requireInteger` in `src/number.mjs` must throw TypeError for fractional input.", sourceText: source + wrong, testText: directTest,
    sourceEntries: [{ path: module, text: source }, { path: "src/wrong.mjs", text: wrong }],
    testEntries: [{ path: "test/number.test.mjs", text: directTest }], namedTargets: ["requireInteger"], provenanceTargets: [] });
  assert.deepEqual(result, { sourceOk: false, testOk: false });
});

test("CommonJS export ownership does not survive shadowing or rebinding the loader objects", () => {
  const source = correct.replace("export function", "function") + "module.exports = { requireInteger };";
  for (const prefix of ["var module = { exports: {} };", "var exports = {};", "module = { exports: {} };", "exports = {};",
    "({ module } = { module: { exports: {} } });", "var [module] = [{ exports: {} }];",
    "var { loader: module } = { loader: { exports: {} } };", "[exports] = [{}];",
    "({ loader: { current: module } } = { loader: { current: { exports: {} } } });"]) {
    assert.deepEqual(route([{ path: module, text: prefix + source }]).unresolvedTargets, [target], prefix);
  }
});

const copyRecords = `function copyRows(input) {
 const output = structuredClone(input);
 for (const row of input.rows) output.entries[row.key] = {value: structuredClone(row.value)};
 return output;
}`;
for (const [label,source] of [
 ["empty local record",`function copyRows(input) {const output={};output[input.key]={value:1};return output;}`],
 ["native cloned local record",copyRecords],
 ["renamed local copy",copyRecords.replaceAll('output','copied')],
 ["nested static receiver",copyRecords.replace('output.entries[','output.nested.entries[')],
 ["multiple copied records",copyRecords.replace('return output;',`output.entries[input.key] = {value:2};return output;`)]
]) test(`source-origin local data store: ${label}`,()=>assert.deepEqual(route([{path:module,text:correct+source}]).strictTargets,[target]));

for (const [label,source] of [
 ["input alias",copyRecords.replace('structuredClone(input)','input')],
 ["caller-owned receiver",copyRecords.replace('output.entries[','input.entries[')],
 ["unknown clone helper",copyRecords.replace('structuredClone(input)','copy(input)')],
 ["shadowed clone parameter",copyRecords.replace('copyRows(input)','copyRows(input, structuredClone)')],
 ["shadowed clone declaration",'function structuredClone(input){return input;}\n'+copyRecords],
 ["imported clone lookalike",`import {structuredClone} from './copy.js';\n`+copyRecords],
 ["reassigned native clone",'structuredClone = value => value;\n'+copyRecords],
 ["aliased native clone",'const clone = structuredClone;\n'+copyRecords],
 ["global native replacement",'globalThis.structuredClone = value => value;\n'+copyRecords],
 ["clone with options",copyRecords.replace('structuredClone(input)','structuredClone(input,{transfer:[]})')],
 ["clone of unrelated binding",copyRecords.replace('structuredClone(input)','structuredClone(other)')],
 ["clone of field instead of declared parameter",copyRecords.replace('structuredClone(input)','structuredClone(input.rows)')],
 ["mutable binding",copyRecords.replace('const output','let output')],
 ["local copy declared after store",`function copyRows(input){output[input.key]={value:1};const output={};return output;}`],
 ["block-local input alias",copyRecords.replace('for (const row of input.rows) output.entries[row.key] = {value: structuredClone(row.value)};','for(const row of input.rows){const output=input;output.entries[row.key]={value:1};}')],
 ["catch alias",copyRecords.replace('for (const row of input.rows) output.entries[row.key] = {value: structuredClone(row.value)};','try{}catch(output){output[input.key]={value:1};}')],
 ["nested function alias",copyRecords.replace('for (const row of input.rows) output.entries[row.key] = {value: structuredClone(row.value)};','function write(output){output[input.key]={value:1};}write(input);')],
 ["nested class binding",copyRecords.replace('for (const row of input.rows) output.entries[row.key] = {value: structuredClone(row.value)};','{class output{};output[input.key]={value:1};}')],
 ["destructuring rebind",copyRecords.replace('return output;','[output] = [input];return output;')],
 ["computed receiver chain",copyRecords.replace('output.entries[','output[input.part][')],
 ["prototype receiver",copyRecords.replace('output.entries[','output.__proto__[')],
 ["computed function store",copyRecords.replace('{value: structuredClone(row.value)}','value=>value')],
 ["computed function alias store",copyRecords.replace('{value: structuredClone(row.value)}','requireInteger')],
 ["record with computed member",copyRecords.replace('{value: structuredClone(row.value)}','{[row.field]:1}')],
 ["record with spread",copyRecords.replace('{value: structuredClone(row.value)}','{...row}')],
 ["record with nested competing method",copyRecords.replace('{value: structuredClone(row.value)}','{requireInteger(value){return value;}}')],
 ["record with competing function reference",copyRecords.replace('{value: structuredClone(row.value)}','{requireInteger}')],
 ["record with nested competing arrow",copyRecords.replace('{value: structuredClone(row.value)}','{nested:{requireInteger:value=>value}}')],
 ["unknown top-level store",`const output={};output[key]={value:1};`],
 ["CommonJS receiver",`function copyRows(input){const exports={};exports[input.key]={value:1};return exports;}`],
 ["another module with a computed callable",copyRecords+`const key='requireInteger';export const other={[key](value){return value;}};`],
 ["bounded local store analysis",`function copyRows(input){const output={};${'output[input.key]={value:1};'.repeat(33)}return output;}`]
]) test(`source-origin refuses unproved dynamic store: ${label}`,()=>assert.deepEqual(route([{path:module,text:correct+source}]).unresolvedTargets,[target]));

test('classifying a local data store never substitutes for the requested rejection behavior',()=>{
 const wrong=correct.replace("if (!Number.isInteger(value)) throw new TypeError('integer'); ",'')+copyRecords;
 assert.deepEqual(route([{path:module,text:wrong}]).strictTargets,[target]);
 assert.deepEqual(acceptanceInvalidInputEvidence({taskText:request,sourceText:wrong,testText:directTest,
  sourceEntries:[{path:module,text:wrong}],testEntries:[{path:'test/number.test.mjs',text:directTest}],namedTargets:['requireInteger'],provenanceTargets:[]}),{sourceOk:false,testOk:true});
});
