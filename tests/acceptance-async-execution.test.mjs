import assert from "node:assert/strict";
import test from "node:test";
import { runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { data, callback, record, plan, returns, throws, callbackPlan, stepReturn, stepThrow, callEvent, settleEvent, errorInput, errorObserved } from "./helpers/async-contract-cases.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const run = (source, cases) => runIndependentContract({ planText: JSON.stringify(plan(source, cases)), imageId, dockerSocket });
const asyncCase = (extra = {}) => ({ id: "one", args: [], awaitResult: true, expected: returns(7), ...extra });
const check = (result, verdict) => { assert.equal(result.verdict, verdict, JSON.stringify(result)); assert.equal(result.execution.cleanupConfirmed, true); };

test("approved async mode settles nested Promises, thenables, synchronous values and top-level await", integration, async () => {
  for (const source of ["export const run=()=>7", "export async function run(){await undefined;return 7}",
    "export const run=()=>Promise.resolve(Promise.resolve(7))", "export const run=()=>({then(resolve){resolve(7)}})",
    "const value=await Promise.resolve(7);export const run=()=>value"]) check(await run(source, [asyncCase()]), "pass");
  check(await run("export async function run(){await undefined;throw new RangeError('failed')}", [asyncCase({ expected: throws("RangeError") })]), "pass");
});

test("sync mode still abstains on Promises and async mode abstains on unresolved work or denied imports", integration, async () => {
  for (const source of ["export async function run(){return 7}", "const value=await Promise.resolve(7);export const run=()=>value"])
    check(await run(source, [{ id: "one", args: [], expected: returns(7) }]), "unknown");
  for (const source of ["export const run=()=>new Promise(()=>{})",
    "export async function run(){await undefined;try{await import('node:fs')}catch{}return 7}"])
    check(await run(source, [asyncCase()]), "unknown");
});

test("actual object identity distinguishes a no-op return from a shape-equal copy", integration, async () => {
  const item = asyncCase({ args: [data({ version: 1, values: [2] }), data(7)], observeIdentity: true,
    expected: returns({ version: 1, values: [2] }, { returnIdentity: [0] }) });
  check(await run("export async function run(value){await undefined;return value}", [item]), "pass");
  const clone = await run("export async function run(value){return {...value}}", [item]); check(clone, "fail");
  assert.deepEqual(clone.counterexamples[0].evidence.observed.returnIdentity, []);
  check(await run("export const run=x=>x", [asyncCase({ args: [data(7)], observeIdentity: true, expected: returns(7, { returnIdentity: [] }) })]), "pass");
});

test("callback traces retain arguments, completion order, nested references and unchanged inputs", integration, async () => {
  const args = [record({ operation: callback("op"), sleep: callback("sleep") })];
  const callbacks = [callbackPlan("op", [stepReturn(7)]), callbackPlan("sleep", [stepReturn(undefined)], { settleAfterJobs: 3 })];
  const callbackTrace = [callEvent("sleep", 0, 10), settleEvent("sleep", 0), callEvent("op", 0, "work"), settleEvent("op", 0)];
  const item = asyncCase({ args, callbacks, observeArgs: true, expected: returns(7, { callbackTrace, argsAfter: args }) });
  check(await run("export async function run({operation,sleep}){await sleep(10);return await operation('work')}", [item]), "pass");
  const bad = await run("export async function run({operation,sleep}){sleep(10);return await operation('work')}", [item]); check(bad, "fail");
  assert.equal(bad.counterexamples[0].evidence.observed.callbackTrace[1].callback, "op", "calling sleep is not evidence of awaiting it");
});

test("the same callback error and its attached checkpoint are observed independently", integration, async () => {
  for (const mode of ["sync", "promise"]) {
    const callbacks = [callbackPlan("op", [stepThrow("failed")], { mode })];
    const callbackTrace = [callEvent("op", 0, "item"), ...(mode === "promise" ? [settleEvent("op", 0, "throw")] : [])];
    const item = asyncCase({ args: [callback("op")], callbacks, errors: [errorInput("failed", "RangeError", { code: "E_WORK" })], observeError: true,
      expected: throws("RangeError", { callbackTrace, errorObservation: errorObserved("failed", { code: "E_WORK", checkpoint: { nextIndex: 2, results: [5] } }) }) });
    const source = "export async function run(op){try{return await op('item')}catch(error){error.checkpoint={nextIndex:2,results:[5]};throw error}}";
    check(await run(source, [item]), "pass");
    check(await run(source.replace("throw error", "const copy=new RangeError(error.message);Object.assign(copy,error);throw copy"), [item]), "fail");
  }
});

test("captured Promise, serialization, identity and callback intrinsics survive candidate tampering", integration, async () => {
  const source = `Promise.resolve=()=>Promise.reject('forged');JSON.stringify=()=> 'forged';Object.is=()=>false;
    WeakMap.prototype.get=()=>undefined;WeakMap.prototype.set=()=>{};String.prototype.slice=()=> 'forged';
    Object.prototype.toJSON=()=> 'forged';Object.getOwnPropertyDescriptor=()=>({value:'forged'});Reflect.ownKeys=()=>[];
    export async function run(op,value){await op(value);return value}`;
  const args = [callback("op"), data({ x: 7 })];
  const item = asyncCase({ args, observeArgs: true, observeIdentity: true, callbacks: [callbackPlan("op", [stepReturn(undefined)])],
    expected: returns({ x: 7 }, { argsAfter: args, returnIdentity: [1], callbackTrace: [callEvent("op", 0, { x: 7 }), settleEvent("op", 0)] }) });
  check(await run(source, [item]), "pass");
});

test("unbounded guest jobs stop without accepting a caught exception as proof", integration, async () => {
  const result = await run("export async function run(){for(;;)await undefined}", [asyncCase()]); check(result, "error");
  assert.equal(result.execution.observation.cases[0].reason, "async-job-limit");
});

test("candidate thenable pollution cannot forge an early callback settlement", integration, async () => {
  for (const statement of ["Object.prototype.then=()=>{}", "Object.defineProperty(Object.prototype,'then',{get(){while(true){}}})"]) {
    const item = asyncCase({ args: [callback("op")], callbacks: [callbackPlan("op", [stepReturn({ x: 1 })])],
      expected: returns(7, { callbackTrace: [callEvent("op", 0), settleEvent("op", 0)] }) });
    const result = await run(`export function run(op){${statement};op();return 7}`, [item]); check(result, "error");
    assert.equal(result.execution.observation.cases[0].reason, "callback-response-unsupported");
  }
});

test("callback overflow, exhausted plans and unsupported arguments remain sticky verifier faults", integration, async () => {
  for (const [body, reason, repeatLast] of [
    ["for(let i=0;i<65;i++)try{op(i)}catch{}", "callback-trace-limit", true],
    ["try{op(1);op(2)}catch{}", "callback-plan-exhausted", false],
    ["try{op(()=>7)}catch{}", "callback-argument-unsupported", false],
    ["try{op({get x(){while(true){}}})}catch{}", "callback-argument-unsupported", false],
    ["try{op(new Proxy({x:7},{ownKeys(){while(true){}}}))}catch{}", "callback-argument-unsupported", false]
  ]) {
    const item = asyncCase({ args: [callback("op")], callbacks: [callbackPlan("op", [stepReturn(undefined)], { mode: "sync", repeatLast })], expected: returns(7, { callbackTrace: [] }) });
    const result = await run(`export function run(op){${body};return 7}`, [item]); check(result, "error");
    assert.equal(result.execution.observation.cases[0].reason, reason);
  }
});

test("a later sequence step cannot reuse an earlier callback under new approved inputs", integration, async () => {
  const source = "let saved;export function run(op){if(!saved){saved=op;return 7}try{saved()}catch{}return 7}";
  const cases = ["first", "second"].map(id => asyncCase({ id, sequence: "history", args: [callback("op")],
    callbacks: [callbackPlan("op", [stepReturn(7)], { mode: "sync" })], expected: returns(7, { callbackTrace: [] }) }));
  const result = await run(source, cases); check(result, "error");
  assert.equal(result.execution.observation.cases[1].reason, "stale-callback-invocation");
});

test("error observation refuses executable getters and proxies rather than calling serializers", integration, async () => {
  for (const expression of ["Object.defineProperty(new Error(), 'checkpoint', {enumerable:true,get(){while(true){}}})",
    "Object.defineProperty(new Error(), 'checkpoint', {get(){while(true){}}})", "new Proxy(new Error(),{})"]) {
    const item = asyncCase({ observeError: true, expected: throws("Error", { errorObservation: errorObserved(null) }) });
    check(await run(`export async function run(){throw ${expression}}`, [item]), "unknown");
  }
});

test("error checkpoint references use observed data across a reset, never the expected answer", integration, async () => {
  const first = { id: "failed", sequence: "history", exportName: "fail", args: [], observeError: true,
    expected: throws("Error", { errorObservation: errorObserved(null, { checkpoint: { nextIndex: 2 } }) }) };
  const resumed = { id: "resumed", sequence: "history", reset: true, args: [{ type: "error-property", value: "failed", key: "checkpoint" }], expected: returns(99) };
  const result = await run("export function fail(){throw Object.assign(new Error(),{checkpoint:{nextIndex:99}})}export const run=x=>x.nextIndex", [first, resumed]);
  check(result, "fail");
  assert.deepEqual(result.execution.observation.cases[1].value, data(99));
  assert.equal(result.counterexamples.length, 1);
  assert.equal(result.counterexamples[0].evidence.input.id, "failed");
  check(await run("export function fail(){throw new Error()}export const run=()=>99", [first, resumed]), "fail");
  const missing = await run("export function fail(){throw new Error()}export const run=()=>99",
    [{ ...first, expected: throws("Error", { errorObservation: errorObserved(null) }) }, resumed]);
  check(missing, "unknown"); assert.equal(missing.execution.observation.cases[1].reason, "referenced-result-unavailable");
});

test("referenced Date data keeps side-effect coverage and executable references cannot cross cases", integration, async () => {
  const source = "export function fail(){throw Object.assign(new Error(),{checkpoint:new Date(0)})}export const run=date=>date.getTime()";
  const first = { id: "failed", sequence: "history", exportName: "fail", args: [], observeError: true,
    expected: throws("Error", { errorObservation: errorObserved(null, { checkpoint: new Date(0) }) }) };
  const next = { id: "resumed", sequence: "history", reset: true, args: [{ type: "error-property", value: "failed", key: "checkpoint" }], expected: returns(0) };
  const result = await run(source, [first, next]); check(result, "pass");
  assert.deepEqual(result.execution.observation.cases[1].dateArgsAfter, [{ index: 0, value: 0 }]);
  const withCallback = { ...first, args: [callback("op")], callbacks: [callbackPlan("op", [stepReturn(0)], { mode: "sync" })],
    expected: throws("Error", { callbackTrace: [], errorObservation: { identity: null, properties: record({ checkpoint: callback("op") }) } }) };
  const refused = await run("export function fail(op){throw Object.assign(new Error(),{checkpoint:op})}export const run=()=>0", [withCallback, next]);
  check(refused, "unknown"); assert.equal(refused.execution.observation.cases[1].reason, "referenced-result-unavailable");
});

test("async imports stay inside the explicit source graph and denied delayed imports cannot be caught into a pass", integration, async () => {
  for (const [specifier, verdict] of [["./value.js", "pass"], ["./missing.js", "unknown"], ["node:fs", "unknown"]]) {
    const input = plan(`export async function run(){await undefined;try{return (await import('${specifier}')).value}catch{return 7}}`, [asyncCase()]);
    input.moduleGraph = { entry: "src/main.js", dependencies: [{ path: "src/value.js", source: "export const value=7" }] };
    check(await runIndependentContract({ planText: JSON.stringify(input), imageId, dockerSocket }), verdict);
  }
});

test("a queued infinite job retains the same CPU ceiling and resource evidence", integration, async () => {
  const result = await run("export async function run(){await undefined;while(true){}}", [asyncCase()]); check(result, "error");
  assert.ok(result.execution.observation, JSON.stringify(result));
  assert.equal(result.execution.observation.cases[0].reason, "guest-cpu-budget");
  assert.ok(result.execution.observation.cases[0].resources.caseThreadCpuMicros >= 300000);
});

test("jobs created while observing an error cannot invalidate snapshots and then count as complete", integration, async () => {
  const source = "export function run(){throw new Proxy(new Error(),{getPrototypeOf(){Promise.resolve().then(()=>7);return Error.prototype}})}";
  const result = await run(source, [asyncCase({ expected: throws("Error") })]); check(result, "unknown");
  assert.equal(result.execution.observation.cases[0].reason, "async-job-unsupported");
});
