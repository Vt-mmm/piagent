import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { compileIndependentContract, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { parseResponse, WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { data, plan, returns, throws, errorObserved } from "./helpers/async-contract-cases.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const pair = () => ({ id: "fresh-results", left: { root: "return", path: ["results"] }, right: { root: "argument", index: 0, path: ["results"] } });
const item = () => ({ id: "one", args: [data({ results: [7] })], referencePairs: [pair()],
  expected: returns({ results: [7] }, { referenceIdentity: [{ id: "fresh-results", same: false }] }) });
const compile = input => compileIndependentContract(JSON.stringify(plan("export const run=x=>x", [input])));
const run = (source, input = item()) => runIndependentContract({ imageId, dockerSocket, planText: JSON.stringify(plan(source, [input])) });

test("reference selectors are bounded data, never executable paths or implicit roots", () => {
  assert.ok(compile(item()));
  for (const mutate of [
    value => { value.referencePairs = []; }, value => { value.referencePairs = Array(17).fill(pair()); },
    value => { value.referencePairs.push(pair()); }, value => { value.referencePairs[0].left.root = "global"; },
    value => { value.referencePairs[0].right.index = 1; }, value => { value.referencePairs[0].right.index = -1; },
    value => { value.referencePairs[0].left.index = 0; }, value => { value.referencePairs[0].left.path = "results"; },
    value => { value.referencePairs[0].left.path = Array(9).fill("x"); }, value => { value.referencePairs[0].left.path = [0]; },
    value => { value.referencePairs[0].left.root = "error"; }, value => { delete value.expected.referenceIdentity; },
    value => { value.expected.referenceIdentity[0].id = "other"; }, value => { value.expected.referenceIdentity[0].same = "false"; },
    value => { delete value.referencePairs; }
  ]) { const value = item(); mutate(value); assert.throws(() => compile(value)); }
  const error = item(); error.referencePairs[0].left.root = "error"; error.observeError = true;
  assert.ok(compile(error));
});

test("reference coverage is mandatory in worker responses and cannot be supplied by older versions", () => {
  const input = item(), request = JSON.parse(compile(input).requestText);
  const good = { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: "digest", status: "completed",
    cases: [{ id: "one", ...input.expected, dateArgsAfter: [], clockReads: 0 }] };
  assert.deepEqual(parseResponse(JSON.stringify(good), request, "digest"), good);
  for (const mutate of [value => { delete value.cases[0].referenceIdentity; }, value => { value.cases[0].referenceIdentity = []; },
    value => { value.cases[0].referenceIdentity[0].same = 0; }, value => { value.workerVersion = "quickjs-contract-worker-v7"; },
    value => { value.cases[0] = { id: "one", outcome: "unsupported", reason: "reference-path-unsupported", referenceIdentity: [] }; }]) {
    const value = structuredClone(good); mutate(value); assert.throws(() => parseResponse(JSON.stringify(value), request, "digest"));
  }
});

test("published schemas require explicit reference expectations and bounded selectors", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/approved-host-contracts.schema.json", import.meta.url)));
  const ajv = new Ajv({ strict: false }); ajv.addSchema(schema); const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/case` });
  assert.equal(validate(item()), true, JSON.stringify(validate.errors));
  for (const mutate of [value => { delete value.expected.referenceIdentity; }, value => { value.referencePairs[0].left.index = 0; },
    value => { value.referencePairs[0].left.path = [false]; }, value => { value.expected.referenceIdentity[0].same = 0; }]) {
    const value = item(); mutate(value); assert.equal(validate(value), false);
  }
});

test("actual nested return identity separates fresh arrays from shape-equal aliases", integration, async () => {
  for (const [source, verdict, same] of [["export const run=x=>({results:[...x.results]})", "pass", false],
    ["export const run=x=>({results:x.results})", "fail", true]]) {
    const result = await run(source); assert.equal(result.verdict, verdict, JSON.stringify(result));
    assert.deepEqual(result.execution.observation.cases[0].referenceIdentity, [{ id: "fresh-results", same }]);
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});

test("an attached checkpoint must be a new object even when failure occurs before any progress", integration, async () => {
  const input = item(); input.observeError = true;
  input.args = [data({ nextIndex: 0, results: [] })];
  input.referencePairs[0] = { id: "new-checkpoint", left: { root: "error", path: ["checkpoint"] }, right: { root: "argument", index: 0, path: [] } };
  input.expected = throws("Error", { errorObservation: errorObserved(null, { checkpoint: { nextIndex: 0, results: [] } }), referenceIdentity: [{ id: "new-checkpoint", same: false }] });
  for (const [value, verdict] of [["{...checkpoint}", "pass"], ["checkpoint", "fail"]]) {
    const result = await run(`export function run(checkpoint){throw Object.assign(new Error(),{checkpoint:${value}})}`, input);
    assert.equal(result.verdict, verdict, JSON.stringify(result));
  }
});

test("reference identity uses captured intrinsics, own data and arbitrary string keys", integration, async () => {
  const input = item(); input.args = [data(JSON.parse('{"__proto__":[7]}'))];
  input.referencePairs[0].left.path = ["nested", "0"];
  input.referencePairs[0].right.path = ["__proto__"];
  input.expected = returns({ nested: [[7]] }, { referenceIdentity: [{ id: "fresh-results", same: true }] });
  const result = await run("Object.is=()=>false;Object.getOwnPropertyDescriptor=()=>({value:undefined});WeakSet.prototype.has=()=>false;export const run=x=>({nested:[x['__proto__']]})", input);
  assert.equal(result.verdict, "pass", JSON.stringify(result));
});

test("missing or primitive references are not object aliases, while value mismatches remain concrete failures", integration, async () => {
  for (const source of ["export const run=x=>({})", "export const run=x=>({results:7})"]) {
    const result = await run(source); assert.equal(result.verdict, "fail", JSON.stringify(result));
    assert.equal(result.execution.observation.cases[0].referenceIdentity[0].same, false);
  }
  const input = item(); input.args = [data({})]; input.referencePairs[0].left.root = "argument"; input.referencePairs[0].left.index = 0;
  const result = await run("export function run(x){Object.setPrototypeOf(x,{results:[7]});return {results:[7]}}", input);
  assert.equal(result.verdict, "pass", JSON.stringify(result));
});

test("reference observation never executes getters or proxy traps introduced into arguments", integration, async () => {
  for (const change of ["Object.defineProperty(x,'results',{get(){while(true){}}})", "x.results=new Proxy([],{getPrototypeOf(){while(true){}}})"]) {
    const result = await run(`export function run(x){${change};return {results:[7]}}`);
    assert.equal(result.verdict, "unknown", JSON.stringify(result));
    assert.equal(result.execution.observation.cases[0].reason, "reference-path-unsupported");
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});

test("Node backing-store projection distinguishes a shared Buffer view from a byte-equal copy", integration, async () => {
  const input = { type: "buffer", value: { backingBase64: "YWJjZA==", byteOffset: 0, byteLength: 4 } };
  const pair = { id: "shared-backing", left: { root: "return", path: [], projection: "backing-store" },
    right: { root: "argument", index: 0, path: [], projection: "backing-store" } };
  const item = { id: "view", invocation: { kind: "call" }, args: [input], referencePairs: [pair],
    expected: { outcome: "return", value: { type: "buffer", value: { backingBase64: "YWJjZA==", byteOffset: 1, byteLength: 3 } },
      referenceIdentity: [{ id: "shared-backing", same: true }] } };
  const execute = source => runIndependentContract({ imageId, dockerSocket, timeoutMs: 30000, planText: JSON.stringify({ schemaVersion: 2,
    profile: expectedNodeProfile(), source, exportName: "run", checks: [{ id: "backing", cases: [item] }] }) });
  const shared = await execute("export const run=value=>value.subarray(1)");
  assert.equal(shared.verdict, "pass", JSON.stringify(shared));
  assert.deepEqual(shared.execution.observation.cases[0].referenceIdentity, [{ id: "shared-backing", same: true }]);
  const copied = await execute("export const run=value=>Buffer.from(value).subarray(1)");
  assert.equal(copied.verdict, "fail", JSON.stringify(copied));
  assert.deepEqual(copied.execution.observation.cases[0].referenceIdentity, [{ id: "shared-backing", same: false }]);
});
