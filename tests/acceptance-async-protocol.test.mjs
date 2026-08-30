import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { compileIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { parseResponse, WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { data, callback, plan, returns, throws, callbackPlan, stepReturn, stepThrow, callEvent, settleEvent, errorInput, errorObserved } from "./helpers/async-contract-cases.mjs";

const one = () => ({ id: "one", args: [callback("operation")], awaitResult: true, observeError: true,
  errors: [errorInput("rejection", "RangeError")], callbacks: [callbackPlan("operation", [stepThrow("rejection")], { settleAfterJobs: 2 })],
  expected: throws("RangeError", { callbackTrace: [callEvent("operation", 0), settleEvent("operation", 0, "throw")], errorObservation: errorObserved("rejection") }) });
const compile = item => compileIndependentContract(JSON.stringify(plan("export const run=callback=>callback()", [item])));

test("async capability plans carry only approved data to the worker, never expected observations", () => {
  const compiled = compile(one()), request = JSON.parse(compiled.requestText);
  assert.equal(request.cases[0].awaitResult, true);
  assert.deepEqual(request.cases[0].callbacks, one().callbacks);
  assert.ok(!Object.hasOwn(request.cases[0], "expected"));
  assert.ok(!compiled.requestText.includes("callbackTrace"));
  const changed = one(); changed.callbacks[0].settleAfterJobs = 3;
  assert.notEqual(compile(changed).planDigest, compiled.planDigest);
  assert.ok(Object.isFrozen(compiled.plan.checks[0].cases[0].callbacks[0].steps));
});

for (const [name, mutate] of [
  ["implicit async flags", item => { item.awaitResult = false; }],
  ["unbound callback", item => { item.args = [callback("other")]; }],
  ["duplicate callback", item => { item.callbacks.push(item.callbacks[0]); }],
  ["unbound error", item => { item.callbacks[0].steps[0].error = "other"; }],
  ["duplicate error", item => { item.errors.push(item.errors[0]); }],
  ["executable callback body", item => { item.callbacks[0].source = "return true"; }],
  ["recursive callback response", item => { item.callbacks[0].steps = [{ outcome: "return", value: callback("operation") }]; }],
  ["executable error property", item => { item.errors[0].properties.value.push({ key: "f", value: callback("operation") }); }],
  ["empty callback plan", item => { item.callbacks[0].steps = []; }],
  ["unbounded delay", item => { item.callbacks[0].settleAfterJobs = 33; }],
  ["sync settlement delay", item => { item.callbacks[0].mode = "sync"; }],
  ["missing trace", item => { delete item.expected.callbackTrace; }],
  ["missing error observation", item => { delete item.expected.errorObservation; }],
  ["unknown observed error", item => { item.expected.errorObservation.identity = "other"; }],
  ["missing settlement", item => { item.expected.callbackTrace.pop(); }],
  ["settlement before call", item => { item.expected.callbackTrace.reverse(); }],
  ["duplicate settlement", item => { item.expected.callbackTrace.push(item.expected.callbackTrace[1]); }],
  ["wrong settlement outcome", item => { item.expected.callbackTrace[1].outcome = "return"; }],
  ["non-sequential invocation", item => { item.expected.callbackTrace[0].call = 1; }],
  ["non-error properties", item => { item.expected.errorObservation.properties = data([]); }],
  ["identity on a throw", item => { item.observeIdentity = true; item.expected.returnIdentity = []; }]
]) test(`async contract validation rejects ${name}`, () => assert.throws(() => { const item = one(); mutate(item); compile(item); }));

test("return identity requires actual object argument indices and an explicit expectation", () => {
  const item = { id: "identity", args: [data({ x: 1 }), data(1)], observeIdentity: true, expected: returns({ x: 1 }, { returnIdentity: [0] }) };
  assert.ok(compile(item));
  for (const returnIdentity of [undefined, [1], [-1], [0, 0], [0.5], [2]]) {
    assert.throws(() => compile({ ...item, expected: { ...item.expected, returnIdentity } }));
  }
  assert.throws(() => compile({ ...item, observeIdentity: undefined }));
});

test("async worker responses require complete capability coverage and exact v7 binding", () => {
  const item = one(), request = JSON.parse(compile(item).requestText);
  const response = { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: "digest", status: "completed",
    cases: [{ id: "one", ...item.expected, clockReads: 0, dateArgsAfter: [] }] };
  assert.deepEqual(parseResponse(JSON.stringify(response), request, "digest"), response);
  for (const mutate of [
    value => { delete value.cases[0].callbackTrace; }, value => { delete value.cases[0].errorObservation; },
    value => { value.cases[0].callbackTrace[1].call = 2; }, value => { value.cases[0].returnIdentity = []; },
    value => { value.workerVersion = "quickjs-contract-worker-v6"; },
    value => { value.cases[0] = { id: "one", outcome: "unsupported", reason: "async-promise-unsettled", callbackTrace: [] }; }
  ]) { const bad = structuredClone(response); mutate(bad); assert.throws(() => parseResponse(JSON.stringify(bad), request, "digest")); }
  const basic = JSON.parse(compile({ id: "basic", args: [], expected: returns(true) }).requestText);
  const forged = { ...response, cases: [{ id: "basic", outcome: "return", value: data(true), dateArgsAfter: [], clockReads: 0, callbackTrace: [] }] };
  assert.throws(() => parseResponse(JSON.stringify(forged), basic, "digest"));
});

test("published schemas accept async data plans and reject invalid capability structure", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/approved-host-contracts.schema.json", import.meta.url)));
  const ajv = new Ajv({ strict: false, allErrors: true }); ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/case` });
  assert.equal(validate(one()), true, JSON.stringify(validate.errors));
  for (const mutate of [
    item => { item.callbacks[0].mode = "host"; }, item => { item.callbacks[0].settleAfterJobs = 0; },
    item => { item.callbacks[0].mode = "sync"; }, item => { item.awaitResult = false; },
    item => { delete item.expected.callbackTrace; }, item => { delete item.expected.errorObservation; },
    item => { item.expected.callbackTrace[0].outcome = "return"; },
    item => { item.errors[0].properties = data([]); }, item => { item.callbacks[0].steps = [stepReturn(() => true)]; }
  ]) { const bad = one(); mutate(bad); assert.equal(validate(bad), false, JSON.stringify(bad)); }
});

test("error-property references require observed earlier errors in the same contiguous history", () => {
  const first = { id: "failed", sequence: "history", args: [], observeError: true,
    expected: throws("Error", { errorObservation: errorObserved(null, { checkpoint: { nextIndex: 2 } }) }) };
  const next = { id: "resumed", sequence: "history", reset: true, args: [{ type: "error-property", value: "failed", key: "checkpoint" }], expected: returns(2) };
  const make = cases => compileIndependentContract(JSON.stringify(plan("export const run=()=>0", cases)));
  assert.ok(make([first, next]));
  for (const cases of [[next, first], [{ ...first, observeError: undefined }, next], [first, { ...next, sequence: "other" }],
    [first, { ...next, args: [{ type: "error-property", value: "failed", key: 1 }] }],
    [first, { ...next, args: [{ type: "record", value: [{ key: "nested", value: next.args[0] }] }] }]]) assert.throws(() => make(cases));
});
