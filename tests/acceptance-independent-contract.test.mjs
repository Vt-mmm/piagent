import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compileIndependentContract, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const num = (value) => ({ type: "number", value });
const bool = (value) => ({ type: "boolean", value });
const ret = (value, extra = {}) => ({ outcome: "return", value, ...extra });
const plan = (source) => ({ schemaVersion: 1, source, exportName: "run", checks: [
  { id: "strict-before", cases: [{ id: "before", args: [num(10), num(9)], expected: ret(bool(false)) }] },
  { id: "inclusive-boundary", cases: [{ id: "equal", args: [num(10), num(10)], expected: ret(bool(true)) }] },
  { id: "strict-after", cases: [{ id: "after", args: [num(10), num(11)], expected: ret(bool(true)) }] }
] });
const execute = (input, options = {}) => runIndependentContract({ planText: JSON.stringify(input), imageId, dockerSocket, ...options });

test("expected answers stay outside guest protocol and plans are immutable and bound", () => {
  const input = plan("export const run = (expiry, now) => now >= expiry");
  const compiled = compileIndependentContract(JSON.stringify(input));
  const request = JSON.parse(compiled.requestText);
  assert.equal(request.cases.length, 3);
  assert.ok(request.cases.every((item) => !Object.hasOwn(item, "expected")));
  input.checks[1].cases[0].expected.value.value = false;
  assert.notEqual(compileIndependentContract(JSON.stringify(input)).planDigest, compiled.planDigest);
  assert.throws(() => { compiled.plan.checks[0].cases[0].expected.value.value = true; }, TypeError);
});

test("vacuous, contradictory, duplicate, and undefined expectations are rejected before execution", () => {
  const good = plan("export const run = () => true");
  for (const bad of [
    { ...good, checks: [] }, { ...good, checks: [good.checks[0], good.checks[0]] },
    { ...good, checks: [{ id: "empty", cases: [] }] },
    { ...good, checks: [{ id: "wrong", cases: [{ id: "one", args: [], expected: { outcome: "return" } }] }] },
    { ...good, checks: [{ id: "wrong", cases: [{ id: "one", args: [], expected: { outcome: "pass", value: bool(true) } }] }] },
    { ...good, checks: [{ id: "wrong", cases: [{ id: "one", args: [], expected: ret(bool(true), { errorClass: "Error" }) }] }] }
  ]) assert.throws(() => compileIndependentContract(JSON.stringify(bad)));
});

test("compiler plan v2 binds the public Node profile and finite invocation data without sending expected answers", () => {
  const input = { schemaVersion: 2, profile: expectedNodeProfile(), source: "export class Cache{set(){}get(){return 1}}", exportName: "Cache", checks: [
    { id: "receiver", cases: [
      { id: "new", sequence: "s", args: [], invocation: { kind: "construct", receiverId: "cache" }, expected: { outcome: "constructed" } },
      { id: "get", sequence: "s", args: [], invocation: { kind: "method", receiverId: "cache", method: "get" }, expected: ret(num(1)) }
    ] }
  ] };
  const compiled = compileIndependentContract(JSON.stringify(input)), request = JSON.parse(compiled.requestText);
  assert.equal(compiled.version, "bounded-node-profile-contract-comparison-v3");
  assert.deepEqual(request.profile, expectedNodeProfile());
  assert.ok(request.cases.every(item => !Object.hasOwn(item, "expected")));
  for (const mutate of [value => { value.profile.digest = "0".repeat(64); }, value => { delete value.checks[0].cases[0].invocation; },
    value => { value.checks[0].cases[0].expected = ret(num(1)); }, value => { value.checks[0].cases[1].invocation.method = "delete"; }]) {
    const invalid = structuredClone(input); mutate(invalid); assert.throws(() => compileIndependentContract(JSON.stringify(invalid)));
  }
});

test("real comparison accepts structurally different implementations of the same bounded contract", integration, async () => {
  for (const source of [
    "export const run = (expiry, now) => now >= expiry",
    "function compare(a,b,inclusive) { let result = a > b; if (inclusive && a === b) result = true; return result; } export function run(expiry,now) { return compare(now,expiry,true); }",
    "export function run(expiry, now) { if (expiry > now) return false; return true; }"
  ]) {
    const result = await execute(plan(source));
    assert.equal(result.verdict, "pass", JSON.stringify(result));
    assert.deepEqual(result.checks.map((item) => item.status), ["pass", "pass", "pass"]);
    assert.ok(!Object.hasOwn(result, "completionAllowed"));
  }
});

test("real comparison rejects wrong boundaries with a host-captured reproducible counterexample", integration, async () => {
  for (const source of ["export const run = (expiry,now) => now > expiry", "export const run = () => true", "export const run = () => false"]) {
    const result = await execute(plan(source));
    assert.equal(result.verdict, "fail", JSON.stringify(result));
    assert.ok(result.counterexamples.length > 0);
    const { digest, evidence } = result.counterexamples[0];
    assert.equal(createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), digest);
    assert.ok(result.checks.some((item) => item.counterexampleRef === digest));
    assert.notDeepEqual(evidence.expected.value, evidence.observed.value);
  }
});

test("unsupported code and backend faults remain distinct from an observed wrong behavior", integration, async () => {
  const unsupported = await execute(plan("export const run = () => Promise.resolve(true)"));
  assert.equal(unsupported.verdict, "unknown");
  assert.equal(unsupported.counterexamples.length, 0);
  const infinite = await execute(plan("export function run() { while (true) {} }"));
  assert.equal(infinite.verdict, "error");
  assert.equal(infinite.counterexamples.length, 0);
  const missing = await execute(plan("export const run = () => true"), { dockerSocket: "/nonexistent/piagent-contract-test.sock" });
  assert.equal(missing.verdict, "error");
});

test("host comparison checks TypeError and Date mutation obligations independently", integration, async () => {
  const invalid = plan("export const run = () => { throw {name:'TypeError'}; }");
  invalid.checks = [{ id: "invalid-input", cases: [{ id: "invalid", args: [num("NaN")], expected: { outcome: "throw", errorClass: "TypeError" } }] }];
  assert.equal((await execute(invalid)).verdict, "fail");
  invalid.source = "export const run = () => { throw new TypeError('invalid'); }";
  assert.equal((await execute(invalid)).verdict, "pass");
  const mutation = plan("export const run = d => { d.setTime(20); return true; }");
  mutation.checks = [{ id: "input-stability", cases: [{ id: "date", args: [{ type: "date", value: 10 }],
    expected: ret(bool(true), { dateArgsAfter: [{ index: 0, value: 10 }] }) }] }];
  assert.equal((await execute(mutation)).verdict, "fail");
});
