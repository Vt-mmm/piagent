// Development calibration only. These examples are not a held-out evaluation.
// Expected values are contract tables, never computed by a candidate program.
export function data(value) {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (value instanceof Date) return { type: "date", value: Number.isNaN(value.getTime()) ? "NaN" : value.getTime() };
  if (Array.isArray(value)) return { type: "array", value: value.map(data) };
  if (typeof value === "object") return { type: "record", value: Object.entries(value).map(([key, item]) => ({ key, value: data(item) })) };
  return { type: typeof value, value: typeof value === "number" && !Number.isFinite(value) ? String(value)
    : Object.is(value, -0) ? "-0" : value };
}
const returns = (value) => ({ outcome: "return", value: data(value) });
const raises = (errorClass = "TypeError") => ({ outcome: "throw", errorClass });
const call = (id, args, expected, extra = {}) => ({ id, args: args.map(data), expected, ...extra });
const contract = (source, cases, exportName = "run") => ({ schemaVersion: 1, source, exportName, checks: [{ id: "specified-behavior", cases }] });

const sumA = `export function run(values) { let sum=0; for(const x of values) {
  if(typeof x!=='number'||!Number.isFinite(x)) throw new TypeError(); sum+=x; } return sum; }`;
const sumB = `export const run = xs => { if(xs.some(x=>typeof x!=='number'||!Number.isFinite(x))) throw new TypeError();
  return xs.reduce((total,x)=>total+x,0); };`;
const sumCases = [call("empty", [[]], returns(0)), call("signed", [[7, -3, 0, 2]], returns(6)),
  call("fraction", [[0.5, 0.25]], returns(0.75)), call("invalid-text", [[1, "2"]], raises()), call("invalid-nan", [[NaN]], raises())];

const timeA = `export function run(expiry,now) { const value=expiry instanceof Date?expiry.getTime():expiry;
  if(typeof value!=='number'||!Number.isFinite(value)||typeof now!=='number'||!Number.isFinite(now)) throw new TypeError();
  return {expired:now>=value,remaining:Math.max(0,value-now)}; }`;
const timeB = `export function run(expiry, now) { let end=expiry;
  if(Object.prototype.toString.call(end)==='[object Date]') end=Number(end);
  for(const n of [end,now]) if(typeof n!=='number'||!Number.isFinite(n)) throw new TypeError();
  return now<end?{remaining:end-now,expired:false}:{remaining:0,expired:true}; }`;
const timeCases = [call("before", [100, 99], returns({ expired: false, remaining: 1 })),
  call("equal", [100, 100], returns({ expired: true, remaining: 0 })),
  call("after", [100, 101], returns({ expired: true, remaining: 0 })),
  call("date", [new Date(100), 99], { ...returns({ expired: false, remaining: 1 }), dateArgsAfter: [{ index: 0, value: 100 }] }),
  call("invalid-date", [new Date(NaN), 0], raises()), call("invalid-now", [100, NaN], raises()), call("text", ["100", 99], raises())];

// First non-undefined wins; null, false, zero and empty string are explicit values.
const configA = `export function run(options, environment, defaults) {
  const pick=key=>options[key]!==undefined?options[key]:environment[key]!==undefined?environment[key]:defaults[key];
  return {limit:pick('limit'),enabled:pick('enabled'),label:pick('label')}; }`;
const configB = `export function run(a,b,c) { const out={}; for(const key of ['label','enabled','limit']) {
  for(const source of [a,b,c]) if(source[key]!==undefined) { out[key]=source[key]; break; }
  if(!(key in out)) out[key]=undefined; } return out; }`;
const defaults = { limit: 9, enabled: true, label: "default" };
const configCases = [call("defaults", [{}, {}, defaults], returns(defaults)),
  call("false-values", [{ limit: 0, enabled: false, label: "" }, {}, defaults], returns({ limit: 0, enabled: false, label: "" })),
  call("environment", [{ limit: undefined }, { limit: 3, label: "env" }, defaults], returns({ limit: 3, enabled: true, label: "env" })),
  call("null", [{ enabled: null, label: null }, { limit: 4 }, defaults], returns({ limit: 4, enabled: null, label: null })),
  call("missing", [{}, {}, {}], returns({ limit: undefined, enabled: undefined, label: undefined }))];

const ledgerA = `let entries=new Map(), total=0;
export function apply(id,delta) { if(!entries.has(id)) { entries.set(id,delta); total+=delta; } return total; }
export const snapshot=()=>({version:1,entries:[...entries],total});
export function restore(saved) { entries=new Map(saved.entries); total=saved.total; return total; }
export const read=()=>total;`;
const ledgerB = `let journal=[]; const total=()=>journal.reduce((s,e)=>s+e[1],0);
export function apply(id,delta) { if(!journal.some(e=>e[0]===id)) journal.push([id,delta]); return total(); }
export const snapshot=()=>({total:total(),entries:journal.map(e=>[...e]),version:1});
export function restore(saved) { journal=saved.entries.map(e=>[...e]); return total(); }
export const read=()=>total();`;
const saved = { version: 1, entries: [["x", 7]], total: 7 };
const ledgerCall = (id, exportName, args, expected, extra = {}) => call(id, args, returns(expected), { sequence: "checkpoint-history", exportName, ...extra });
const ledgerCases = [ledgerCall("add", "apply", ["x", 7], 7), ledgerCall("saved", "snapshot", [], saved),
  ledgerCall("later", "apply", ["y", -3], 4), ledgerCall("restart", "read", [], 0, { reset: true }),
  ledgerCall("restore", "restore", [], 7, { args: [{ type: "result", value: "saved" }], observeArgs: true,
    expected: { ...returns(7), argsAfter: [data(saved)] } }),
  ledgerCall("duplicate", "apply", ["x", 7], 7), ledgerCall("new", "apply", ["z", -2], 5),
  ledgerCall("final", "snapshot", [], { version: 1, entries: [["x", 7], ["z", -2]], total: 5 }),
  ledgerCall("independent", "read", [], 0, { sequence: "fresh-history" })];

export function developmentCorpus() {
  const rows = [];
  const add = (domain, cases, variants) => {
    for (const [id, expectedVerdict, source, rationale] of variants) rows.push({ id: `${domain}:${id}`, domain, expectedVerdict, rationale, plan: contract(source, cases) });
  };
  add("pure-function", sumCases, [
    ["loop", "pass", sumA, "Finite-number sum, including empty and signed lists."],
    ["reduction", "pass", sumB, "Equivalent up-front validation and reduction."],
    ["drops-negative", "fail", sumA.replace("sum+=x", "sum+=Math.max(0,x)"), "Signed-list expected sum is 6, not 9."],
    ["coerces-text", "fail", "export const run=xs=>xs.reduce((s,x)=>s+Number(x),0)", "String and NaN inputs must throw TypeError."],
    ["async", "unknown", sumA.replace("export function", "export async function"), "Async result handling is not supported by this backend."]
  ]);
  add("temporal-input", timeCases, [
    ["direct", "pass", timeA, "Inclusive expiry and nonnegative remaining duration."],
    ["branching", "pass", timeB, "Equivalent branching and Date normalization."],
    ["strict-boundary", "fail", timeA.replace("now>=value", "now>value"), "Equality is expired."],
    ["negative-remaining", "fail", timeA.replace("Math.max(0,value-now)", "value-now"), "Remaining duration is clamped after expiry."],
    ["async", "unknown", timeA.replace("export function", "export async function"), "Async result handling is unsupported."]
  ]);
  add("configuration-precedence", configCases, [
    ["selection", "pass", configA, "Only undefined means inherit."],
    ["iteration", "pass", configB, "Equivalent explicit source precedence."],
    ["truthiness", "fail", configA.replace("options[key]!==undefined?options[key]:environment[key]!==undefined?environment[key]:defaults[key]", "options[key]||environment[key]||defaults[key]"), "Falsy and null overrides are explicit."],
    ["defaults-first", "fail", configA.replace("options[key]!==undefined?options[key]", "defaults[key]!==undefined?defaults[key]"), "Defaults must not override a present option."],
    ["imports", "unknown", "import fs from 'node:fs'; export const run=()=>fs;", "Closed-module adapter has no import authority."]
  ]);
  add("stateful-recovery", ledgerCases, [
    ["indexed", "pass", ledgerA, "Event IDs are idempotent; restore uses the last saved checkpoint."],
    ["journal", "pass", ledgerB, "Equivalent journal representation without a cached total."],
    ["duplicate-applied", "fail", ledgerA.replace("if(!entries.has(id))", "if(true)"), "Replayed x must not add 7 again."],
    ["dedup-lost", "fail", ledgerA.replace("entries=new Map(saved.entries)", "entries=new Map()"), "Checkpoint must retain applied event IDs."],
    ["total-lost", "fail", ledgerA.replace("total=saved.total", "total=0"), "Restored total must be 7."],
    ["async", "unknown", ledgerA.replace("export function apply", "export async function apply"), "Unawaited async observations cannot pass."]
  ]);
  return { schemaVersion: 1, id: "harness-next-development-v1", split: "development", heldOut: false, claimEligible: false, rows };
}
