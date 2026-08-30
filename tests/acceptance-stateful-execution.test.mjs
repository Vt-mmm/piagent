import assert from "node:assert/strict";
import test from "node:test";
import { compileIndependentContract, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { parseRequest, parseResponse, WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { validateValue, numberValue, canonicalValue } from "../packages/piagent-core/extensions/acceptance-executor/values.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const encode = (value) => {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (value instanceof Date) return { type: "date", value: numberValue(value.getTime()) };
  if (Array.isArray(value)) return { type: "array", value: value.map(encode) };
  if (typeof value === "object") return { type: "record", value: Object.entries(value).map(([key, item]) => ({ key, value: encode(item) })) };
  return { type: typeof value, value: typeof value === "number" ? numberValue(value) : value };
};
const returned = (value, extra = {}) => ({ outcome: "return", value: encode(value), ...extra });
const plan = (source, cases) => ({ schemaVersion: 1, source, exportName: "run", checks: [{ id: "behavior", cases }] });
const run = (value) => runIndependentContract({ planText: JSON.stringify(value), imageId, dockerSocket });
const request = (cases) => JSON.parse(compileIndependentContract(JSON.stringify(plan("export const run=x=>x", cases))).requestText);

test("structured protocol bounds trees and rejects duplicate keys, executable references and malformed collections", () => {
  const good = encode({ array: [false, 0, -0, NaN, Infinity, null, undefined, "\"\\\n"], nested: { date: new Date(0) } });
  assert.equal(validateValue(good), good);
  const duplicate = { type: "record", value: [{ key: "a", value: encode(1) }, { key: "a", value: encode(2) }] };
  let deep = encode(0); for (let index = 0; index < 9; index += 1) deep = { type: "array", value: [deep] };
  for (const bad of [duplicate, deep, { type: "array", value: Array(65).fill(encode(0)) },
    { type: "array", value: [{ type: "result", value: "previous" }] },
    { type: "record", value: [{ key: 1, value: encode(0) }] }]) assert.throws(() => validateValue(bad));
  assert.throws(() => validateValue(good, false), /Unsupported value type/, "Date output stays an explicit unsupported contract");
  assert.deepEqual(canonicalValue(encode({ b: 2, a: 1 })), canonicalValue(encode({ a: 1, b: 2 })));
  assert.notDeepEqual(canonicalValue(encode([1, 2])), canonicalValue(encode([2, 1])));
});

test("sequence references are backwards, same-history and explicit, never host expected answers", () => {
  const first = { id: "first", sequence: "history", args: [], expected: returned(1) };
  const second = { id: "second", sequence: "history", reset: true, exportName: "restore", args: [{ type: "result", value: "first" }], expected: returned(1) };
  const good = request([first, second]);
  assert.ok(good.cases.every((item) => !Object.hasOwn(item, "expected")));
  assert.equal(good.cases[1].args[0].value, "first");
  for (const cases of [
    [second, first], [first, { ...second, args: [{ type: "result", value: "second" }] }],
    [first, { ...second, sequence: "other" }], [first, { ...second, sequence: undefined, reset: undefined }],
    [first, { id: "outside", args: [], expected: returned(0) }, second],
    [{ ...first, sequence: undefined, reset: true }], [{ ...first, exportName: "run();process.exit()" }],
    [{ ...first, observeArgs: "true" }], [{ ...first, expected: returned(1, { argsAfter: [] }) }]
  ]) assert.throws(() => request(cases));
});

test("structured worker observations must include the requested complete argument snapshots", () => {
  const req = request([{ id: "one", args: [encode({ a: 1 })], observeArgs: true, expected: returned(1) }]);
  const good = { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: "digest", status: "completed", cases: [
    { id: "one", outcome: "return", value: encode(1), dateArgsAfter: [], clockReads: 0, argsAfter: [encode({ a: 1 })] }
  ] };
  assert.deepEqual(parseResponse(JSON.stringify(good), req, "digest"), good);
  for (const argsAfter of [undefined, [], [encode(1), encode(2)], [{ type: "record", value: [{ key: "x" }] }]]) {
    assert.throws(() => parseResponse(JSON.stringify({ ...good, cases: [{ ...good.cases[0], argsAfter }] }), req, "digest"));
  }
  assert.equal(parseRequest(JSON.stringify(req)).cases[0].observeArgs, true);
});

test("repeated counterexample histories have a host-side byte budget before execution", () => {
  const cases = Array.from({ length: 128 }, (_, index) => ({ id: `step-${index}`, sequence: "large-history", args: [encode("x".repeat(3500))], expected: returned(0) }));
  assert.throws(() => request(cases), /history budget exceeded/);
});

test("actual structured observations preserve special values and own __proto__ without invoking candidate serializers", integration, async () => {
  const data = JSON.parse('{"__proto__":{"safe":true},"list":[0,false,null],"constructor":"data"}');
  data.list.push(undefined, -0, NaN, Infinity, "\"\\\n");
  const source = `JSON.stringify = () => 'forged'; Object.prototype.toJSON = () => 'forged'; Array.prototype.toJSON = () => 'forged';
    Object.getOwnPropertyDescriptor = () => ({value:'forged'}); Reflect.ownKeys = () => [];
    WeakSet.prototype.has = () => false; WeakSet.prototype.delete = () => false;
    Object.prototype.get = () => 'forged'; Object.prototype.set = () => {};
    export const run = value => value;`;
  const result = await run(plan(source, ["initial", "after-tampering"].map((id) => ({ id, sequence: "tamper", args: [encode(data)], observeArgs: true,
    expected: returned(data, { argsAfter: [encode(data)] }) }))));
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(result.execution.cleanupConfirmed, true);
});

test("actual records compare independent of insertion order and expose nested input mutation", integration, async () => {
  const ordered = await run(plan("export const run = () => ({b:2,a:1});", [{ id: "record", args: [], expected: returned({ a: 1, b: 2 }) }]));
  assert.equal(ordered.verdict, "pass", JSON.stringify(ordered));
  const mutation = await run(plan("export const run = x => { x.nested[0]=99; return true; };", [{ id: "mutate", args: [encode({ nested: [1, 2] })], observeArgs: true,
    expected: returned(true, { argsAfter: [encode({ nested: [1, 2] })] }) }]));
  assert.equal(mutation.verdict, "fail", JSON.stringify(mutation));
  assert.deepEqual(mutation.counterexamples[0].evidence.observed.argsAfter, [encode({ nested: [99, 2] })]);
  const allowed = await run(plan("export const run = x => { x.nested[0]=99; return true; };", [{ id: "allowed", args: [encode({ nested: [1, 2] })], observeArgs: true,
    expected: returned(true, { argsAfter: [encode({ nested: [99, 2] })] }) }]));
  assert.equal(allowed.verdict, "pass", "the harness must not freeze an otherwise mutable input");
});

test("accessors, cycles, sparse arrays, proxies and oversized data abstain without executing getters", integration, async () => {
  for (const expression of ["{ get x(){ while(true) {} } }", "(()=>{const x={}; x.self=x; return x})()", "Array(2)",
    "new Proxy({x:1},{ownKeys(){while(true){}}})", "Proxy.revocable({x:1},{}).proxy", "Array(65).fill(1)",
    "new Map([['x',1]])", "{ nested: Promise.resolve(1) }", "{ [Symbol('x')]: 1 }"]) {
    const result = await run(plan(`export const run = () => (${expression});`, [{ id: "unsupported", args: [], expected: returned({ x: 1 }) }]));
    assert.equal(result.verdict, "unknown", JSON.stringify({ expression, result }));
    assert.equal(result.counterexamples.length, 0);
    assert.equal(result.execution.cleanupConfirmed, true);
  }
  const internalProxy = await run(plan("export const run = () => [new Proxy({x:1},{}).x, Proxy.name, Proxy.length, Object.hasOwn(Proxy,'prototype'), Proxy.revocable.length];",
    [{ id: "supported", args: [], expected: returned([1, "Proxy", 2, false, 2]) }]));
  assert.equal(internalProxy.verdict, "pass", JSON.stringify(internalProxy));
});

test("inherited proxy traps cannot expose an untracked constructor or revocable factory", integration, async () => {
  for (const factory of [
    "Object.prototype.get = target => target; const raw = Proxy.hidden; delete Object.prototype.get; return new raw(value, traps);",
    "Object.prototype.getPrototypeOf = target => target; const raw = Object.getPrototypeOf(Proxy); delete Object.prototype.getPrototypeOf; return new raw(value, traps);",
    "const wrapped = Proxy.revocable; Object.prototype.get = target => target; const raw = wrapped.hidden; delete Object.prototype.get; return raw(value, traps).proxy;"
  ]) {
    const result = await run(plan(`export function run() {
      const value = {x:2}, traps = {getOwnPropertyDescriptor(){return {value:1,enumerable:true,configurable:true}}};
      ${factory}
    }`, [{ id: "inherited-trap", args: [], expected: returned({ x: 1 }) }]));
    assert.notEqual(result.verdict, "pass", JSON.stringify({ factory, result }));
    assert.ok(!result.execution.observation.cases.some((item) => item.outcome === "return"), "candidate traps must not supply the observed data");
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});

const statefulSource = `let entries = new Map(), total = 0;
export function apply(id, delta) { if (!entries.has(id)) { entries.set(id,delta); total += delta; } return total; }
export function snapshot() { return {version:1, entries:[...entries], total}; }
export function restore(saved) { entries = new Map(saved.entries); total = saved.total; return total; }
export const read = () => total;`;
const equivalentSource = `let journal=[];
const total = () => journal.reduce((sum, entry) => sum + entry[1], 0);
export function apply(id, delta) { if(journal.every(entry=>entry[0]!==id)) journal.push([id,delta]); return total(); }
export const snapshot = () => ({total:total(), entries:journal.map(entry=>[...entry]), version:1});
export function restore(saved) { journal=saved.entries.map(entry=>[...entry]); return total(); }
export const read = () => total();`;
const oldSnapshot = { version: 1, entries: [["a", 5]], total: 5 };
function statefulPlan(source) {
  const call = (id, exportName, args, expected, extra = {}) => ({ id, sequence: "recovery", exportName, args: args.map(encode), expected: returned(expected), ...extra });
  return plan(source, [
    call("add-a", "apply", ["a", 5], 5), call("saved", "snapshot", [], oldSnapshot),
    call("uncommitted-b", "apply", ["b", 7], 12), call("restart", "read", [], 0, { reset: true }),
    call("restore", "restore", [], 5, { args: [{ type: "result", value: "saved" }], observeArgs: true,
      expected: returned(5, { argsAfter: [encode(oldSnapshot)] }) }),
    call("replayed-a", "apply", ["a", 5], 5), call("add-c", "apply", ["c", -2], 3),
    call("final", "snapshot", [], { version: 1, entries: [["a", 5], ["c", -2]], total: 3 }),
    call("fresh-history", "read", [], 0, { sequence: "independent" })
  ]);
}

test("actual stateful histories survive only through their returned checkpoint across a fresh realm", integration, async () => {
  for (const source of [statefulSource, equivalentSource]) {
    const result = await run(statefulPlan(source));
    assert.equal(result.verdict, "pass", JSON.stringify(result));
    assert.equal(result.checks[0].caseCount, 9);
  }
});

test("actual stateful defects produce a replayable full prefix, not a context-free last call", integration, async () => {
  for (const source of [statefulSource.replace("if (!entries.has(id))", "if (true)"),
    statefulSource.replace("entries = new Map(saved.entries)", "entries = new Map()"),
    statefulSource.replace("total = saved.total", "total = 0")]) {
    const input = statefulPlan(source), result = await run(input);
    assert.equal(result.verdict, "fail", JSON.stringify(result));
    const example = result.counterexamples[0].evidence;
    assert.equal(example.input.prefix[0].id, "add-a");
    assert.equal(example.input.prefix.at(-1).id, example.input.id);
    assert.ok(example.input.prefix.some((item) => item.reset));
    assert.ok(example.input.prefix.every((item) => !Object.hasOwn(item, "expected")));
    const prefixIds = new Set(example.input.prefix.map((item) => item.id));
    const replay = await run(plan(source, input.checks[0].cases.filter((item) => prefixIds.has(item.id))));
    assert.equal(replay.verdict, "fail", "the exact failing history must reproduce");
  }
});

test("an unsupported checkpoint never invokes a dependent restore or becomes a passing history", integration, async () => {
  const result = await run(plan("let called=0; export const snapshot=()=>()=>1; export const restore=()=>++called; export const read=()=>called;", [
    { id: "saved", sequence: "one", exportName: "snapshot", args: [], expected: returned({ value: 1 }) },
    { id: "restore", sequence: "one", exportName: "restore", args: [{ type: "result", value: "saved" }], expected: returned(1) },
    { id: "check", sequence: "one", exportName: "read", args: [], expected: returned(0) }
  ]));
  assert.equal(result.verdict, "unknown", JSON.stringify(result));
  assert.equal(result.execution.observation.cases[1].reason, "referenced-result-unavailable");
  assert.deepEqual(result.execution.observation.cases[2].value, encode(0));
});

test("each call has its own clock observation while explicit histories retain program state", integration, async () => {
  const result = await run(plan("let count=0; export const run=()=>[Date.now(),++count];", [
    { id: "first", sequence: "clock", args: [], clock: 100, expected: returned([100, 1], { clockReads: 1 }) },
    { id: "second", sequence: "clock", args: [], clock: 300, expected: returned([300, 2], { clockReads: 1 }) },
    { id: "reset", sequence: "clock", reset: true, args: [], clock: 500, expected: returned([500, 1], { clockReads: 1 }) }
  ]));
  assert.equal(result.verdict, "pass", JSON.stringify(result));
});
