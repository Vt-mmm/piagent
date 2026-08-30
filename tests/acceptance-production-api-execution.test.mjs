import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { retrySources, retryCases, checkpointSources, checkpointCases, configSources, configCases, workflowSources, workflowCases } from "./helpers/async-production-cases.mjs";
import { data, returns } from "./helpers/async-contract-cases.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const run = (source, exportName, cases) => runIndependentContract({ imageId, dockerSocket,
  planText: JSON.stringify({ schemaVersion: 1, source, exportName, checks: [{ id: "public-api", cases }] }) });
const assertVerdict = (result, verdict) => { assert.equal(result.verdict, verdict, JSON.stringify(result)); assert.equal(result.execution.cleanupConfirmed, true); };

for (const [name, exportName, sources, cases, file] of [
  ["bounded retry", "retry", retrySources, retryCases, "reliability/retry.js"],
  ["partial checkpoint", "resumeWork", checkpointSources, checkpointCases, "reliability/checkpoint.js"],
  ["four-layer configuration", "resolveConfig", configSources, configCases, "platform/config.js"],
  ["tagged workflow reducer", "reduceWorkflowSession", workflowSources, workflowCases, "platform/workflow-session.js"]
]) test(`unchanged ${name} API accepts equivalent implementations and rejects the exposed faulty fixture`, integration, async () => {
  for (const source of sources) assertVerdict(await run(source, exportName, cases()), "pass");
  const faulty = fs.readFileSync(new URL(`../benchmarks/production-v2/project/src/${file}`, import.meta.url), "utf8");
  assertVerdict(await run(faulty, exportName, cases()), "fail");
});

for (const [name, before, after] of [
  ["extra attempt", "attempt===maxAttempts", "attempt>maxAttempts"],
  ["linear delay", "2**(attempt-1)", "attempt"],
  ["missing await", "await sleep(", "sleep("],
  ["new final error", "throw error;", "throw new Error(error.message);"],
  ["sleep after final failure", "if(attempt===maxAttempts)throw error; await sleep(baseDelayMs*2**(attempt-1));", "await sleep(baseDelayMs*2**(attempt-1)); if(attempt===maxAttempts)throw error;"]
]) test(`retry contract exposes ${name} without treating an executor error as a defect proof`, integration, async () => {
  const source = retrySources[0].replace(before, after); assert.notEqual(source, retrySources[0]);
  const result = await run(source, "retry", retryCases()); assertVerdict(result, "fail");
  assert.ok(result.counterexamples.length > 0);
});

for (const [name, before, after] of [
  ["replaying prior items", "let index=checkpoint.nextIndex", "let index=0"],
  ["losing partial results", "results:[...results]", "results:[...checkpoint.results]"],
  ["advancing past failed item", "nextIndex:index", "nextIndex:index+1"],
  ["mutating input results", "const results=[...checkpoint.results]", "const results=checkpoint.results"],
  ["wrapping failure", "throw error", "throw Object.assign(new Error(error.message),{checkpoint:error.checkpoint})"]
]) test(`checkpoint contract exposes ${name} using the actual observed recovery data`, integration, async () => {
  const source = checkpointSources[0].replace(before, after); assert.notEqual(source, checkpointSources[0]);
  const result = await run(source, "resumeWork", checkpointCases()); assertVerdict(result, "fail");
  assert.ok(result.counterexamples.some(row => row.evidence.input.prefix?.[0].id === "partial-failure"));
});

test("workflow duplicate identity and validation order cannot be replaced with shape equality", integration, async () => {
  for (const source of [workflowSources[0].replace("some(message=>message.id===event.id))return state", "some(message=>message.id===event.id))return {...state}"),
    workflowSources[0].replace("if(!text(event.id)", "if(state.messages.some(message=>message.id===event.id))return state; if(!text(event.id)")]) {
    assert.notEqual(source, workflowSources[0]); assertVerdict(await run(source, "reduceWorkflowSession", workflowCases()), "fail");
  }
});

test("stale search completions must preserve the exact state, not just its JSON", integration, async () => {
  const state = { requestId: "active", loading: true, results: ["previous"] };
  const cases = ["search/success", "search/failure"].map((type, index) => ({ id: `stale-${index}`, observeIdentity: true, observeArgs: true,
    args: [data(state), data({ type, requestId: "old", results: ["wrong"] })],
    expected: returns(state, { returnIdentity: [0], argsAfter: [data(state), data({ type, requestId: "old", results: ["wrong"] })] }) }));
  const source = "export function searchReducer(state,action){if(action.requestId!==state.requestId)return state;return {...state,loading:false}}";
  assertVerdict(await run(source, "searchReducer", cases), "pass");
  assertVerdict(await run(source.replace("return state", "return {...state}"), "searchReducer", cases), "fail");
});
