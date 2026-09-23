import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { compileIndependentContract, compareIndependentExecution, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { parseRequest, parseResponse, WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { data, plan, throws } from "./helpers/async-contract-cases.mjs";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";

const item = () => ({ id: "conflict", args: [], observeErrorMessage: true,
  expected: throws("Error", { errorMessage: { includes: "conflict", ignoreCase: true } }) });
const source = "export function run(){throw new Error('confirmed message CONFLICT')}";
const compile = (value = item()) => compileIndependentContract(JSON.stringify(plan(source, [value])));
const response = (compiled, message) => ({ schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: "digest", status: "completed",
  cases: [{ id: "conflict", outcome: "throw", errorClass: "Error", errorMessage: message, clockReads: 0, dateArgsAfter: [] }] });
const compare = (compiled, observation) => compareIndependentExecution(compiled,
  { status: "completed", cleanupConfirmed: true, runId: "diagnostic", sourceDigest: "source", imageId: "image", observation });

test("error-message expectation stays on host and requires an explicit case capability", () => {
  const compiled = compile();
  assert.equal(JSON.parse(compiled.requestText).cases[0].observeErrorMessage, true);
  assert.equal(Object.hasOwn(JSON.parse(compiled.requestText).cases[0], "expected"), false);
  assert.equal(compiled.requestText.includes('"ignoreCase"'), false);
  assert.equal(compiled.requestText.includes('"includes"'), false);
  const missing = item(); delete missing.observeErrorMessage;
  assert.throws(() => compile(missing));
  const absent = item(); delete absent.expected.errorMessage;
  assert.throws(() => compile(absent));
});

test("message comparison distinguishes same-class wrong text, case policy, empty and absent message", () => {
  const compiled = compile();
  for (const [message, verdict] of [["confirmed CONFLICT", "pass"], ["unrelated error", "fail"], ["", "fail"], [null, "fail"]]) {
    const observed = parseResponse(JSON.stringify(response(compiled, message)), parseRequest(compiled.requestText), "digest");
    const result = compare(compiled, observed);
    assert.equal(result.verdict, verdict);
    if (verdict === "fail") assert.equal(result.counterexamples[0].evidence.observed.errorMessage, message);
  }
  const sensitive = item(); sensitive.expected.errorMessage.ignoreCase = false;
  const strict = compile(sensitive);
  assert.equal(compare(strict, response(strict, "CONFLICT")).verdict, "fail");
  assert.equal(compare(strict, response(strict, "conflict")).verdict, "pass");
  const missing = response(compiled, "conflict"); delete missing.cases[0].errorMessage;
  assert.equal(compare(compiled, missing).verdict, "fail", "pure comparison cannot accept missing required observation");
});

test("literal predicates reject malformed, empty, excessive or executable-shaped policies", () => {
  for (const value of [null, "conflict", {}, { includes: "", ignoreCase: true }, { includes: "x".repeat(4097), ignoreCase: true },
    { includes: 7, ignoreCase: true }, { includes: "conflict" }, { includes: "conflict", ignoreCase: "i" },
    { includes: "conflict", ignoreCase: true, regexp: ".*" }]) {
    const bad = item(); bad.expected.errorMessage = value;
    assert.throws(() => compile(bad), JSON.stringify(value));
  }
  const returns = item(); returns.expected = { outcome: "return", value: data(7), errorMessage: { includes: "conflict", ignoreCase: true } };
  assert.throws(() => compile(returns));
  const flag = item(); flag.observeErrorMessage = false; assert.throws(() => compile(flag));
});

test("message predicates are literal, including regex metacharacters and explicit /i semantics", () => {
  for (const literal of [".*", "[conflict]", "a+b?", "^$(){}|\\", "k"]) {
    const value = item(); value.expected.errorMessage.includes = literal;
    const compiled = compile(value);
    assert.equal(compare(compiled, response(compiled, `before ${literal} after`)).verdict, "pass");
    assert.equal(compare(compiled, response(compiled, "unrelated text")).verdict, "fail");
  }
  const kelvin = item(); kelvin.expected.errorMessage.includes = "k";
  assert.equal(compare(compile(kelvin), response(null, "\u212a")).verdict, "fail", "match /k/i, not Unicode-folded /k/iu");
  const boundary = item(); boundary.expected.errorMessage.includes = "x".repeat(4096);
  assert.equal(compare(compile(boundary), response(null, "x".repeat(4096))).verdict, "pass");
});

test("published host-plan schemas support the opt-in and reject asymmetric or incompatible declarations", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/approved-host-contracts.schema.json", import.meta.url)));
  const ajv = new Ajv({ allErrors: true, strict: false }); ajv.addSchema(schema);
  for (const definition of ["case", "caseV2"]) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
    const value = { ...item(), ...(definition === "caseV2" ? { invocation: { kind: "call" } } : {}) };
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    for (const change of [entry => { delete entry.observeErrorMessage; }, entry => { delete entry.expected.errorMessage; },
      entry => { entry.expected.errorMessage.includes = ""; }, entry => { entry.expected.errorMessage.ignoreCase = "i"; },
      entry => { entry.expected.outcome = "return"; entry.expected.value = data(7); delete entry.expected.errorClass; }]) {
      const bad = structuredClone(value); change(bad); assert.equal(validate(bad), false, JSON.stringify(bad));
    }
  }
  const profile = ajv.compile({ $ref: `${schema.$id}#/$defs/profileV2` });
  assert.equal(profile(expectedNodeProfile()), true, JSON.stringify(profile.errors));
  assert.equal(profile({ ...expectedNodeProfile(), workerVersion: "quickjs-node-profile-worker-v1" }), false);
});

test("response parser requires bounded message only for opted-in throws, never unsupported or returns", () => {
  const compiled = compile(), request = parseRequest(compiled.requestText);
  for (const change of [value => { delete value.cases[0].errorMessage; }, value => { value.cases[0].errorMessage = 7; },
    value => { value.cases[0].errorMessage = "x".repeat(4097); }, value => { value.cases[0].errorMessage = { includes: "conflict" }; },
    value => { value.cases[0] = { id: "conflict", outcome: "unsupported", reason: "error-message-unsupported", errorMessage: "conflict" }; },
    value => { value.cases[0] = { id: "conflict", outcome: "return", value: data(7), clockReads: 0, dateArgsAfter: [], errorMessage: "conflict" }; }]) {
    const bad = response(compiled, "conflict"); change(bad);
    assert.throws(() => parseResponse(JSON.stringify(bad), request, "digest"));
  }
  const legacy = structuredClone(request); delete legacy.cases[0].observeErrorMessage;
  assert.throws(() => parseResponse(JSON.stringify(response(compiled, "conflict")), legacy, "digest"));
  const incomplete = response(compiled, "conflict"); incomplete.cases[0] = { id: "conflict", outcome: "unsupported", reason: "error-message-unsupported" };
  assert.equal(compare(compiled, parseResponse(JSON.stringify(incomplete), request, "digest")).verdict, "unknown");
  const old = response(compiled, "conflict"); old.workerVersion = "quickjs-contract-worker-v8";
  assert.throws(() => parseResponse(JSON.stringify(old), request, "digest"));
});

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const run = (body, value = item()) => runIndependentContract({ planText: JSON.stringify(plan(body, [value])), imageId, dockerSocket });

test("isolated message observation sees native and inherited text but rejects a wrong-message implementation", integration, async () => {
  for (const [body, verdict] of [[source, "pass"], [source.replace("CONFLICT", "unrelated"), "fail"],
    ["export function run(){const e=new Error();Object.setPrototypeOf(e,Object.create(Error.prototype,{message:{value:'CONFLICT'}}));throw e}", "pass"],
    ["export function run(){throw new Error()}", "fail"], ["export function run(){throw Object.create(null)}", "fail"]]) {
    const result = await run(body); assert.equal(result.verdict, verdict, JSON.stringify(result));
    assert.equal(result.execution.cleanupConfirmed, true);
    assert.equal(Object.hasOwn(result.execution.observation.cases[0], "errorObservation"), false);
    assert.equal(JSON.stringify(result.execution.observation).includes('"stack"'), false);
  }
});

test("message observation does not invoke getters, coercion, proxy traps or excessive prototype chains", integration, async () => {
  for (const expression of [
    "Object.defineProperty(new Error(),'message',{get(){while(true){}}})",
    "Object.setPrototypeOf(new Error(),Object.create(Error.prototype,{message:{get(){while(true){}}}}))",
    "Object.assign(new Error(),{message:{toString(){while(true){}}}})",
    "new Proxy(new Error('conflict'),{getPrototypeOf(){while(true){}},getOwnPropertyDescriptor(){while(true){}}})",
    "Object.setPrototypeOf(new Error('conflict'),new Proxy(Error.prototype,{getPrototypeOf(){while(true){}}}))",
    "new Error('x'.repeat(4097))",
    "(()=>{let e=new Error('conflict');for(let i=0;i<40;i++)e=Object.create(e);return e})()"
  ]) {
    const result = await run(`export function run(){throw ${expression}}`);
    assert.equal(result.verdict, "unknown", JSON.stringify(result));
    assert.equal(result.execution.observation.cases[0].reason, "error-message-unsupported");
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});

test("captured observers resist tampering and legacy error-property snapshots stay unchanged", integration, async () => {
  const body = "Object.getOwnPropertyDescriptor=()=>({value:'forged'});Object.getPrototypeOf=()=>null;String.prototype.toLowerCase=()=> 'forged';JSON.stringify=()=> 'forged';export function run(){throw new Error('CONFLICT')}";
  const result = await run(body); assert.equal(result.verdict, "pass", JSON.stringify(result));
  const legacy = { id: "conflict", args: [], observeError: true,
    expected: throws("Error", { errorObservation: { identity: null, properties: data({ code: 7 }) } }) };
  const old = await run("export function run(){throw Object.assign(new Error('private diagnostic'),{code:7})}", legacy);
  assert.equal(old.verdict, "pass", JSON.stringify(old));
  assert.equal(Object.hasOwn(old.execution.observation.cases[0], "errorMessage"), false);
  assert.equal(JSON.stringify(old.execution.observation).includes("private diagnostic"), false);
});

test("Node-profile worker executes the same message capability with exact profile binding", integration, async () => {
  const input = { ...plan(source, [{ ...item(), invocation: { kind: "call" } }]), schemaVersion: 2, profile: expectedNodeProfile() };
  const result = await runIndependentContract({ planText: JSON.stringify(input), imageId, dockerSocket });
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(result.execution.cleanupConfirmed, true);
  assert.equal(result.execution.observation.profileDigest, input.profile.digest);
  assert.equal(result.execution.observation.cases[0].errorMessage, "confirmed message CONFLICT");
});

test("public chat conflict clause distinguishes reference from same-class wrong-message mutant independently", integration, async () => {
  const [, reference] = productionV3ReferenceSolution("reconnect-chat-event-order");
  const events = [
    { kind: "message", eventId: "first", sequence: 1, messageId: "message", role: "user", text: "before", confirmed: true },
    { kind: "message", eventId: "second", sequence: 2, messageId: "message", role: "user", text: "after", confirmed: true }
  ];
  const value = { ...item(), args: [data(events)], observeArgs: true,
    expected: { ...item().expected, argsAfter: [data(events)] } };
  const wrong = reference.replace('new Error("confirmed message conflict")', 'new Error("invalid input")');
  assert.notEqual(wrong, reference);
  for (const [candidate, verdict] of [[reference, "pass"], [wrong, "fail"]]) {
    const input = { ...plan(candidate, [value]), exportName: "projectChatEvents" };
    const result = await runIndependentContract({ planText: JSON.stringify(input), imageId, dockerSocket });
    assert.equal(result.verdict, verdict, JSON.stringify(result));
    assert.equal(result.execution.observation.cases[0].errorClass, "Error");
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});
