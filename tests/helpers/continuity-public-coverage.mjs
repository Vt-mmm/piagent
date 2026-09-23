import assert from "node:assert/strict";
import { data, callback, callbackPlan, stepReturn, throws } from "./async-contract-cases.mjs";
import { checkpointFamilyCases } from "./production-family-cases.mjs";
import { requestFamilyCases } from "./production-reducer-cases.mjs";
import { addPublicApiCoverage } from "./public-api-coverage.mjs";

// Existing public request histories and byte-boundary witnesses. These are
// explicit host checks; they do not import the reference answer or grader.
function checkpoint() {
  const cases = checkpointFamilyCases().map(item => ({ ...item, invocation: { kind: "call" } }));
  for (const [i, value] of [[], "checkpoint", { nextIndex: 0, results: null }, { nextIndex: 0, results: ["unexpected"] }].entries())
    cases.push({ id: `public-invalid-shape-${i}`, args: [data(["a"]), data(value), callback("process")],
      invocation: { kind: "call" }, awaitResult: true,
      callbacks: [callbackPlan("process", [stepReturn("unreachable")], { repeatLast: true })],
      expected: throws("TypeError", { callbackTrace: [] }) });
  const history = cases.slice(0, 2), invalid = cases.filter(item => item.expected.errorClass === "TypeError"),
    successes = cases.filter(item => item.expected.outcome === "return" && !item.sequence);
  for (const item of successes) {
    item.referencePairs = [{ id: "fresh-results", left: { root: "return", path: ["results"] },
      right: { root: "argument", index: 1, path: ["results"] } }];
    item.expected.referenceIdentity = [{ id: "fresh-results", same: false }];
  }
  return { sourcePath: "src/reliability/checkpoint.js", exportName: "resumeWork", count: 12,
    groups: [cases, [...history, ...invalid], [...history, ...successes], [...history, ...successes],
      [...history, ...successes], history, invalid, invalid, cases.filter(item => item.observeArgs), cases.filter(item => item.observeArgs)],
    anchors: ["Fix `src/reliability/checkpoint.js`", "`checkpoint` contains", "Resume exactly at `nextIndex`;",
      "never process an earlier item again.", "After all remaining items succeed", "When `processItem` throws",
      "`checkpoint` must be a non-null", "reject malformed shapes", "Do not mutate inputs, except", "No other input mutation is permitted."] };
}
function request() {
  const cases = requestFamilyCases().map(item => ({ ...item, invocation: { kind: "call" } }));
  const pick = (...ids) => cases.filter(item => ids.includes(item.id));
  const stale = cases.filter(item => item.id.startsWith("stale-") || item.sequence),
    reconnect = pick("reconnect-cancels-active", "same-reconnect-unchanged", "older-reconnect-unchanged"),
    settle = pick("matching-success-fresh-array", "failure-clears-active"),
    start = pick("start-records-epoch-and-clears-error", "default-start");
  return { sourcePath: "src/frontend/request-lifecycle.js", exportName: "requestLifecycleReducer", count: 12,
    groups: [cases, cases, [...reconnect, ...stale], [...settle, ...stale], [...stale, ...reconnect], start,
      settle, [...settle, ...reconnect], cases, pick("matching-success-fresh-array")],
    anchors: ["Fix `src/frontend/request-lifecycle.js`", "The reducer tracks one active request",
      "A newer `connection/reconnect` epoch", "Success or failure may settle work only", "stale, duplicate, or older-epoch",
      "Starting a request records", "A successful settlement stores results", "both clear the active request",
      "Do not mutate state", "Store successful results in a fresh array."] };
}
const typed = (bytes, type = "uint8array", offset = 0, length = bytes.length) => ({ type,
  value: { backingBase64: Buffer.from(bytes).toString("base64"), byteOffset: offset, byteLength: length } });
function ndjson() {
  const make = (id, chunks, value, errorClass) => {
    const args = [{ type: "array", value: chunks }];
    return { id, args, invocation: { kind: "call" }, observeArgs: true,
      expected: { ...(errorClass ? { outcome: "throw", errorClass } : { outcome: "return", value: data(value) }), argsAfter: args } };
  };
  const bytes = Buffer.from('{"text":"Việt 😀"}\r\n\n{"n":2}'), value = [{ text: "Việt 😀" }, { n: 2 }];
  const splits = Array.from({ length: bytes.length + 1 }, (_, cut) => make(`every-utf8-split-${cut}`,
    [typed(bytes.subarray(0, cut)), typed(bytes.subarray(cut))], value));
  splits.push(make("one-byte-chunks", [...bytes].map(byte => typed([byte])), value));
  const lines = [make("empty-lines-crlf-order", [typed(Buffer.from('\n\r\n{"n":1}\n\n{"n":2}\r\n'))], [{ n: 1 }, { n: 2 }]),
    make("empty-input", [], []), make("final-record", [typed(Buffer.from('{"n":1}'))], [{ n: 1 }])];
  const invalidType = ["{}", null, {}, [123, 125]].map((v, i) => make(`invalid-chunk-type-${i}`, [data(v)], null, "TypeError"));
  invalidType.push(make("arraybuffer-is-not-byte-view", [typed([0, 0], "arraybuffer")], null, "TypeError"));
  const malformed = [make("invalid-leading-utf8", [typed([255])], null, "TypeError"),
    make("incomplete-final-utf8", [typed([226, 130])], null, "TypeError"),
    make("invalid-json", [typed(Buffer.from('{bad}\n'))], null, "SyntaxError")];
  const backing = Buffer.from('x{"n":1}\ny');
  const unchanged = make("subview-backing-unchanged", [typed(backing, "uint8array", 1, backing.length - 2),
    typed(Buffer.from('{"n":2}'))], [{ n: 1 }, { n: 2 }]);
  const all = [...splits, ...lines, ...invalidType, ...malformed, unchanged];
  return { sourcePath: "src/data/ndjson-stream.js", exportName: "parseNdjsonChunks", count: 10,
    groups: [all, [...splits, ...invalidType], invalidType, splits, [...splits, ...lines], lines, malformed, all],
    anchors: ["Replace the naive implementation", "Each input chunk must be a `Uint8Array`;",
      "reject any non-`Uint8Array` chunk", "Decode UTF-8 incrementally", "Parse non-empty NDJSON",
      "Empty physical lines are ignored.", "Invalid UTF-8 or invalid JSON must throw.", "Do not mutate the chunk array"] };
}
export function continuityCoveredContracts(id, criteria) {
  const family = ({ "resumable-checkpoint-partial-failure": checkpoint, "abort-reconnect-supersession": request,
    "chunked-record-boundary": ndjson })[id]();
  assert.equal(criteria.length, family.count);
  family.anchors.forEach((anchor, i) => assert.ok(criteria[i].criterionText.startsWith(anchor)));
  return addPublicApiCoverage(family.groups.map((cases, i) => ({ route: "code", criterionId: criteria[i].criterionId,
    criterionHash: criteria[i].criterionHash, sourcePath: family.sourcePath, exportName: family.exportName,
    maxAttempts: 1, checks: [{ id: `continuity-public-${i + 1}`, cases }] })));
}
