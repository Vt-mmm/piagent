import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { runIsolatedContract } from "../packages/piagent-core/extensions/acceptance-isolated-executor.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { retrySources, retryCases, checkpointSources, checkpointCases, configSources, configCases, workflowSources, workflowCases } from "./helpers/async-production-cases.mjs";
import { callback, callbackPlan, data, errorInput, returns, stepReturn, stepThrow } from "./helpers/async-contract-cases.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const publicRecipeHashes = new Map([
  ["backend/auth.js", "98743a99257d75100ddca29f8827da0f1869d41ae9d55843e5f27880bbd4ecc9"],
  ["backend/billing-window.js", "7f1c7682d0771093e4b116df87f6f30e9f33b56b8eb70c49bc5714198aca76aa"],
  ["backend/cache.js", "d7aba9cec281e1ca72e158a59bab317622ea78820604de7011d345f025f713a4"],
  ["backend/invoice.js", "604a95351479ca1ba5f620a99b5f9a18f31126e42a7f450bb163031f0218b795"],
  ["backend/revocation-cache.js", "53b7ec12381b36e25f854ac0c50ddb07e5595d2ba3ae1a371fb39b2a0f6871de"],
  ["data/csv.js", "b7811a0ac5d20ee316078287d1ebb1db9811a893c99ca89ebd47117a4995c947"],
  ["data/dedup.js", "93de066358db6b29a2eab49cd6b11f0451eb04c9e1d2375f0e7cfff8981c7cf4"],
  ["data/migration.js", "1b4c87315b32b42ecea7336ebac7721ef913d369fe1a1ce3948e549fc893282b"],
  ["data/ndjson-stream.js", "b03dfdfaaa26d6c4c24c8efdf8c8b0e53bdc188639ad43aa7aa048a65d5f5af4"],
  ["data/versioned-replay.js", "d653fe98d42ccaca05c5ab446724fdbe5df0be42d85e17602054032aa6c48a44"],
  ["frontend/chat-events.js", "e8b231af1596fc25707b7595e0ce414fde906ce84f13cf6f37974215b521ab7d"],
  ["frontend/pagination.js", "9a94bd711ed5f5f6f6aca97517b63e4905aef0a0424920d5fce0752311f1ca25"],
  ["frontend/request-lifecycle.js", "55bf07a2780f3952f3658c70722ee6cc6a898a87cab614a73e7bd50e4780f4b4"],
  ["frontend/search-state.js", "c235fa8d778ed1bb446ef195286b13d072e8867cba00250996130914df07984b"],
  ["frontend/unicode-search.js", "e81a8cdf9e022d57e198bfab16618293de8c6708d33c852645e38bd3418e030f"],
  ["fullstack/contract-sync.js", "c34f21bff11a4a3a78924a9326e47e71733e6bbb24c5a68a63ea4572e1383f5f"],
  ["platform/args.js", "073547e1b6298b5f7d18bdc153d8d8e025f6d9a60885d2e28f66b6f3908f3517"],
  ["platform/config.js", "02c58367c922864a64477980507ebbd745f18441538a27910368ea5f19afcbcb"],
  ["platform/workflow-session.js", "7bc0c735f95406b6e5d9d860bf7f3b60837b230d055628c8b6625e172dda0ebd"],
  ["platform/workspace.js", "0398ab06ce4807bd33da8d3790947622740cd30fa12f7150159e56d18c27a84d"],
  ["reliability/checkpoint.js", "23ca4f1f62b697041201e9e861250545f74687c67cd050105a4b301e882dafc7"],
  ["reliability/expiry.js", "a3416ffdb092b7daa9c2a881dcd18deea9348c85eda633ad3d436471ff5cdd46"],
  ["reliability/retry.js", "5e8957a70517da4d563216f9fbb5825ca00a3fc6e1fbb1c7edaa3502faafafcf"]
]);
const run = (source, exportName, cases) => runIndependentContract({ imageId, dockerSocket,
  planText: JSON.stringify({ schemaVersion: 1, source, exportName, checks: [{ id: "public-api", cases }] }) });
const runNode = (source, exportName, cases) => runIndependentContract({ imageId, dockerSocket,
  timeoutMs: 30000,
  planText: JSON.stringify({ schemaVersion: 2, profile: expectedNodeProfile(), source, exportName, checks: [{ id: "node-api", cases }] }) });
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

test("the exact 23 public code recipes execute without a hidden harness or unsupported capability", integration, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  assert.equal(publicRecipeHashes.size, 23);
  const encoded = value => value && typeof value === "object" && ["callback", "uint8array", "buffer", "arraybuffer", "dataview"].includes(value.type)
    ? value : data(value);
  const call = (id, exportName, values, extra = {}) => ({ id, sequence: "public-recipes", exportName,
    invocation: { kind: "call" }, args: values.map(encoded), ...extra });
  const typed = (text, kind = "uint8array") => ({ type: kind,
    value: { backingBase64: Buffer.from(text).toString("base64"), byteOffset: 0, byteLength: Buffer.byteLength(text) } });
  const groups = [
    {
      modules: ["backend/auth.js", "backend/billing-window.js", "backend/cache.js", "backend/invoice.js", "backend/revocation-cache.js",
        "data/csv.js", "data/dedup.js", "data/migration.js", "data/ndjson-stream.js", "data/versioned-replay.js"],
      exports: ["export {canManage as auth} from './backend/auth.js';", "export {billingBucket as billing} from './backend/billing-window.js';",
        "export {TenantCache as Cache} from './backend/cache.js';", "export {invoiceTotalCents as invoice} from './backend/invoice.js';",
        "export {isCachedAccessUsable as revocation} from './backend/revocation-cache.js';", "export {parseCsv as csv} from './data/csv.js';",
        "export {deduplicateEvents as dedup} from './data/dedup.js';", "export {migrateSettings as migration} from './data/migration.js';",
        "export {parseNdjsonChunks as ndjson} from './data/ndjson-stream.js';", "export {replayVersionedEvents as replay} from './data/versioned-replay.js';"],
      cases: [
        call("auth", "auth", [{ active: true, role: "owner", tenantId: "t" }, { tenantId: "t" }]),
        call("billing", "billing", [{ occurredAt: 2, receivedAt: 2 }, { startsAt: 1, endsAt: 3, maxClockSkewMs: 0 }]),
        { id: "cache-new", sequence: "public-recipes", exportName: "Cache", invocation: { kind: "construct", receiverId: "cache" }, args: [] },
        { id: "cache-set", sequence: "public-recipes", invocation: { kind: "method", receiverId: "cache", method: "set" }, args: ["t", "e", "1", { ok: true }].map(data) },
        { id: "cache-get", sequence: "public-recipes", invocation: { kind: "method", receiverId: "cache", method: "get" }, args: ["t", "e", "1"].map(data) },
        call("invoice", "invoice", [[{ unitCents: 100, quantity: 2 }], 0]),
        call("revocation", "revocation", [{ userId: "u", expiresAt: 10 }, { userId: "u", now: 1 }]),
        call("csv", "csv", ["a,b\n1,2"]), call("dedup", "dedup", [[{ id: "a", sequence: 1 }]]),
        call("migration", "migration", [{ version: 1, enabled: false, retries: 0, name: "" }]),
        { id: "ndjson", sequence: "public-recipes", exportName: "ndjson", invocation: { kind: "call" }, args: [{ type: "array", value: [typed('{"ok":true}\n')] }] },
        call("replay", "replay", [{ entities: {}, appliedEventIds: [] }, [{ eventId: "e", entityId: "x", expectedVersion: 0, nextValue: 1 }]])
      ]
    },
    {
      modules: ["frontend/chat-events.js", "frontend/pagination.js", "frontend/request-lifecycle.js", "frontend/search-state.js", "frontend/unicode-search.js",
        "fullstack/contract-sync.js", "platform/args.js", "platform/config.js", "platform/workflow-session.js", "platform/workspace.js"],
      exports: ["export {projectChatEvents as chat} from './frontend/chat-events.js';", "export {pageCount,clampPage} from './frontend/pagination.js';",
        "export {requestLifecycleReducer as request} from './frontend/request-lifecycle.js';", "export {searchReducer as search} from './frontend/search-state.js';",
        "export {normalizeSearchText as normalize,includesSearchText as includes} from './frontend/unicode-search.js';",
        "export {compareSubscriptionContracts as contracts} from './fullstack/contract-sync.js';", "export {parseArgs as args} from './platform/args.js';",
        "export {resolveConfig as config} from './platform/config.js';", "export {reduceWorkflowSession as workflow} from './platform/workflow-session.js';",
        "export {workspaceOrder as workspace} from './platform/workspace.js';"],
      cases: [
        call("chat", "chat", [[{ eventId: "1", kind: "message", messageId: "m", role: "user", text: "hi", sequence: 1, confirmed: true }]]),
        call("page-count", "pageCount", [10, 3]), call("clamp-page", "clampPage", [4, 10, 3]),
        call("request", "request", [{ activeRequestId: null, connectionEpoch: 1, loading: false, results: [], error: null }, { type: "request/start", requestId: "r", epoch: 1 }]),
        call("search", "search", [{ requestId: "r", loading: true, results: [] }, { type: "search/success", requestId: "r", results: [1] }]),
        call("normalize", "normalize", ["  CAFÉ  "]), call("includes", "includes", ["café", "CAFE"]),
        call("contracts", "contracts", [{ statuses: ["active"], fields: [], version: 1 }, { statuses: ["active"], fields: [], version: 1 }]),
        call("args", "args", [["--port", "3", "--", "--literal"]]),
        call("config", "config", [{ port: 0 }, { port: 2 }, { port: 3 }, { port: 4 }]),
        call("workflow", "workflow", [{ currentWorkflow: "a", messages: [] }, { type: "workflow/select", workflow: "b" }]),
        call("workspace", "workspace", [[{ name: "a", dependencies: [] }, { name: "b", dependencies: ["a"] }]])
      ]
    },
    {
      modules: ["reliability/checkpoint.js", "reliability/expiry.js", "reliability/retry.js"],
      exports: ["export {resumeWork as checkpoint} from './reliability/checkpoint.js';", "export {isExpired as expiry} from './reliability/expiry.js';",
        "export {retry} from './reliability/retry.js';"],
      cases: [
        call("checkpoint", "checkpoint", [["a"], { nextIndex: 0, results: [] }, callback("process")], { awaitResult: true,
          callbacks: [callbackPlan("process", [stepReturn("done")], { repeatLast: true })] }),
        call("expiry", "expiry", ["2025-01-01T00:00:00.000Z", 1735689600000]),
        call("retry", "retry", [callback("operation"), { maxAttempts: 2, baseDelayMs: 1 }], { awaitResult: true,
          errors: [errorInput("first")], callbacks: [callbackPlan("operation", [stepThrow("first"), stepReturn("ok")])] })
      ]
    }
  ];
  const seen = new Set();
  for (const [index, group] of groups.entries()) {
    const dependencies = group.modules.map(relative => {
      const sourcePath = path.join(root, "benchmarks/production-v2/project/src", relative), source = fs.readFileSync(sourcePath, "utf8"), expected = publicRecipeHashes.get(relative);
      assert.ok(expected, relative); assert.equal(createHash("sha256").update(source).digest("hex"), expected, relative); seen.add(relative);
      return { path: relative, source };
    });
    const requestText = JSON.stringify({ schemaVersion: 2, profile: expectedNodeProfile(), source: group.exports.join("\n"),
      moduleGraph: { entry: `entry-${index}.mjs`, dependencies }, exportName: group.cases[0].exportName, cases: group.cases });
    const result = await runIsolatedContract({ requestText, profile: expectedNodeProfile(), imageId, dockerSocket, timeoutMs: 30000 });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(result.observation.cases.every(item => ["return", "throw", "constructed"].includes(item.outcome)), JSON.stringify(result));
  }
  assert.equal(seen.size, 23);
});

test("supported byte-decoder alternatives agree and a naive chunk mutant is a concrete failure", integration, async () => {
  const bytes = text => ({ type: "uint8array", value: { backingBase64: Buffer.from(text, "hex").toString("base64"),
    byteOffset: 0, byteLength: text.length / 2 } });
  const chunks = { type: "array", value: [bytes("41f09f"), bytes("988042")] };
  const item = { id: "split-utf8", invocation: { kind: "call" }, args: [chunks],
    expected: { outcome: "return", value: data("A😀B") } };
  const equivalents = [
    "export function decode(chunks){const d=new TextDecoder('utf-8',{fatal:true});let out='';for(const chunk of chunks)out+=d.decode(chunk,{stream:true});return out+d.decode();}",
    "import {TextDecoder} from 'node:util';export function decode(chunks){const d=new TextDecoder('utf-8',{fatal:true});return chunks.map((chunk,index)=>d.decode(chunk,{stream:index+1<chunks.length})).join('');}",
    "import {StringDecoder} from 'string_decoder';export function decode(chunks){const d=new StringDecoder('utf8');let out='';for(const chunk of chunks)out+=d.write(chunk);return out+d.end();}"
  ];
  for (const source of equivalents) assertVerdict(await runNode(source, "decode", [item]), "pass");
  const mutant = "export const decode=chunks=>chunks.map(chunk=>Buffer.from(chunk).toString('utf8')).join('');";
  assertVerdict(await runNode(mutant, "decode", [item]), "fail");
});

test("Buffer, TextEncoder and imported facade identities use actual byte views", integration, async () => {
  const source = `import {Buffer as ImportedBuffer} from 'node:buffer';import {TextEncoder,types} from 'util';
    export function inspect(){const base=ImportedBuffer.from('abc');const view=base.slice(1);view[0]=90;
      const target=ImportedBuffer.alloc(4);const written=target.write('hé');const encoded=new TextEncoder().encodeInto('é!',target);
      return {same:ImportedBuffer===Buffer,isBuffer:ImportedBuffer.isBuffer(view),typed:types.isUint8Array(view),base:base.toString(),
        view:view.toString(),json:view.toJSON(),written,read:encoded.read,encoded:encoded.written,bytes:Array.from(target),
        contains:base.includes('Z'),index:base.indexOf('Z'),last:base.lastIndexOf('c'),length:ImportedBuffer.byteLength('é')};}`;
  const expected = { same: true, isBuffer: true, typed: true, base: "aZc", view: "Zc", json: { type: "Buffer", data: [90, 99] },
    written: 3, read: 2, encoded: 3, bytes: [195, 169, 33, 0], contains: true, index: 1, last: 2, length: 2 };
  const item = { id: "facades", invocation: { kind: "call" }, args: [], expected: { outcome: "return", value: data(expected) } };
  assertVerdict(await runNode(source, "inspect", [item]), "pass");
});

test("nested typed outputs and argument snapshots retain exact copied byte views", integration, async () => {
  const bytes = { type: "uint8array", value: { backingBase64: Buffer.from([0, 127, 255]).toString("base64"),
    byteOffset: 0, byteLength: 3 } }, chunks = { type: "array", value: [bytes] }, nested = { type: "record", value: [
    { key: "nested", value: { type: "array", value: [bytes] } }
  ] };
  const source = "export function inspect(chunks){return {nested:[chunks[0]]}}";
  const item = { id: "nested-typed", invocation: { kind: "call" }, args: [chunks], observeArgs: true,
    expected: { outcome: "return", value: nested, argsAfter: [chunks] } };
  assertVerdict(await runNode(source, "inspect", [item]), "pass");
});

test("private decoder and timer state ignores guest serializer and prototype hooks across instances", integration, async () => {
  const decoderSource = `import {StringDecoder} from 'string_decoder';
    export function inspect(){const one=new TextDecoder('utf-8',{fatal:true}),two=new TextDecoder('utf-8',{fatal:true});
      const jsonStringify=JSON.stringify,jsonParse=JSON.parse,indexOf=String.prototype.indexOf;
      Object.prototype.toJSON=function(){return Object.hasOwn(this,'id')?{...this,id:this.id+1}:this};
      JSON.stringify=()=>'{"fault":true}';JSON.parse=()=>({fault:true});String.prototype.indexOf=()=>0;
      try{const first=one.decode(new Uint8Array([240,159]),{stream:true}),isolated=two.decode(new Uint8Array([66]));
        const completed=first+one.decode(new Uint8Array([152,128]));const left=new StringDecoder('utf8'),right=new StringDecoder('utf8');
        const leftHead=left.write(new Uint8Array([240,159])),rightValue=right.write(new Uint8Array([67]))+right.end();
        return {completed,isolated,stringCompleted:leftHead+left.end(new Uint8Array([152,128])),rightValue};}
      finally{delete Object.prototype.toJSON;JSON.stringify=jsonStringify;JSON.parse=jsonParse;String.prototype.indexOf=indexOf;}}`;
  const decoderExpected = data({ completed: "😀", isolated: "B", stringCompleted: "😀", rightValue: "C" });
  assertVerdict(await runNode(decoderSource, "inspect", [{ id: "decoder-isolation", invocation: { kind: "call" }, args: [],
    expected: { outcome: "return", value: decoderExpected } }]), "pass");

  const timerSource = `export async function inspect(){const seen=[],mapGet=Map.prototype.get,mapSet=Map.prototype.set,mapDelete=Map.prototype.delete;
    const first=setTimeout(()=>seen.push('first'),1),second=setTimeout(()=>seen.push('second'),2);
    Object.prototype.toJSON=function(){return Object.hasOwn(this,'id')?{...this,id:this.id+1}:this};
    Map.prototype.get=()=>{throw new Error('poisoned get')};Map.prototype.set=()=>{throw new Error('poisoned set')};Map.prototype.delete=()=>{throw new Error('poisoned delete')};
    try{clearTimeout(first);await new Promise(resolve=>setTimeout(resolve,4));return seen;}
    finally{delete Object.prototype.toJSON;Map.prototype.get=mapGet;Map.prototype.set=mapSet;Map.prototype.delete=mapDelete;}}`;
  assertVerdict(await runNode(timerSource, "inspect", [{ id: "timer-isolation", invocation: { kind: "call" }, args: [], awaitResult: true,
    expected: { outcome: "return", value: data(["second"]) } }]), "pass");
});

test("pinned Unicode normalization distinguishes an accent-insensitive equivalent from a lowercasing mutant", integration, async () => {
  const item = { id: "unicode", invocation: { kind: "call" }, args: [data("  CAFÉ\tNOIR  ")],
    expected: { outcome: "return", value: data("cafe noir") } };
  const equivalent = "export const normalize=value=>String(value??'').trim().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLocaleLowerCase('en').replace(/\\s+/g,' ');";
  const mutant = "export const normalize=value=>String(value??'').trim().toLowerCase().replace(/\\s+/g,' ');";
  assertVerdict(await runNode(equivalent, "normalize", [item]), "pass");
  assertVerdict(await runNode(mutant, "normalize", [item]), "fail");
});
