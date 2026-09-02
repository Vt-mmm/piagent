import { createHash, createHmac, KeyObject, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { compileCompositeContract } from "../../extensions/acceptance-composite-contract.js";
import { openCompositeJournalAnchor } from "./composite-journal-anchor.ts";
export const COMPOSITE_PLAN_CONTEXT_VERSION = "composite-plan-context-v1", COMPOSITE_FACT_RECORD_VERSION = 2;
export const COMPOSITE_ASSURANCE_VERSION = "composite-assurance-runtime-v1", COMPOSITE_ASSURANCE = "bounded-composite-contract-tested";
const JOURNAL_VERSION = "composite-assurance-journal-v1";
const HASH = /^[a-f0-9]{64}$/, REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/, FACT_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_EVENTS = 512, MAX_BYTES = 32 * 1024 * 1024;
const UNKNOWN = new Set(["unsupported-input", "ambiguous-input", "missing-fact", "stale-binding", "invalid-approval",
  "unavailable-native-boundary", "incomplete-mediation", "untrusted-fact", "response-mismatch", "cancelled", "superseded"]);
const ERRORS = new Set(["producer-crash", "capture-error", "journal-error", "producer-timeout", "producer-cancelled", "cleanup-ambiguous"]);
const FAILURES = new Set(["observed-counterexample", "content-mismatch", "verification-failed", "policy-violation",
  "scope-violation", "persistence-mismatch", "delivery-mismatch", "safety-stop"]);
const BASE_FIELDS = ["projectId", "projectHead", "sourceDigest", "materialSnapshotDigest", "suiteDigest", "configDigest",
  "armDigest", "taskRunId", "sessionId", "operatorRequestDigest", "taskContractDigest", "criterionIndex", "criterionId",
  "criterionHash", "runtimeGeneration", "phaseHeadDigest", "producerManifestDigest", "verifierDigest"];
const RESPONSE_FIELDS = ["origin", "entryId", "digest", "byteLength", "operationRef", "messageRequestId"];
const FACT_FIELDS = ["schemaVersion", "factId", "factSpecDigest", "kind", "producerId", "producerDigest", "ruleDigest",
  "binding", "status", "observationDigest", "counterexampleRef", "reasonCodes"];
const factCapabilities = new WeakMap(), producerCapabilities = new WeakMap(), reservationCapabilities = new WeakMap(),
  preparationCapabilities = new WeakMap(), aggregatePreparationCapabilities = new WeakMap(), aggregateCapabilities = new WeakMap(), publicationCapabilities = new WeakMap();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function exact(value: any, fields: string[], label: string): any {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`Invalid ${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length
    || fields.some(field => !descriptors[field] || !("value" in descriptors[field]) || !descriptors[field].enumerable)) {
    throw new TypeError(`Invalid ${label} fields`);
  }
  return value;
}
function copy(value: any, depth = 0, budget = { nodes: 0, bytes: 0 }): any {
  if (++budget.nodes > 65_536 || depth > 20) throw new TypeError("Composite data exceeds traversal bounds");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new TypeError("Invalid composite number"); return value; }
  if (typeof value === "string") {
    if (!(value as any).isWellFormed()) throw new TypeError("Invalid composite string");
    budget.bytes += Buffer.byteLength(value); if (budget.bytes > 2 * 1024 * 1024) throw new TypeError("Composite data exceeds byte bound");
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value)) throw new TypeError("Invalid composite data");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) throw new TypeError("Invalid composite prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (array && (keys.length !== value.length + 1 || value.length > 4096)) throw new TypeError("Invalid composite array");
  if (!array && keys.length > 64) throw new TypeError("Invalid composite object");
  const output: any = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key as any];
    if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Invalid composite property");
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new TypeError("Invalid composite index");
    output[key] = copy(descriptor.value, depth + 1, budget);
  }
  return output;
}
function key32(key: unknown): asserts key is KeyObject {
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== 32) throw new TypeError("Expected host 256-bit secret key");
}
function signed(key: KeyObject, domain: string, text: string) {
  return createHmac("sha256", key).update(`${domain}\0${text}`).digest("hex");
}
function authentic(key: KeyObject, domain: string, text: string, signature: unknown) {
  return typeof signature === "string" && HASH.test(signature)
    && timingSafeEqual(Buffer.from(signed(key, domain, text), "hex"), Buffer.from(signature, "hex"));
}
function baseBinding(value: any, criterion?: any) {
  exact(value, BASE_FIELDS, "composite binding");
  for (const field of ["projectId", "sourceDigest", "materialSnapshotDigest", "suiteDigest", "configDigest", "armDigest",
    "taskContractDigest", "criterionHash", "phaseHeadDigest", "producerManifestDigest"]) if (!HASH.test(value[field])) throw new TypeError(`Invalid ${field}`);
  if (!REVISION.test(value.projectHead) || !ID.test(value.taskRunId) || !ID.test(value.sessionId)
    || !/^operator-request-v1:[a-f0-9]{64}$/.test(value.operatorRequestDigest)
    || !Number.isSafeInteger(value.criterionIndex) || value.criterionIndex < 0 || value.criterionIndex > 11
    || !FACT_ID.test(value.criterionId) || !Number.isSafeInteger(value.runtimeGeneration) || value.runtimeGeneration < 0
    || value.verifierDigest !== null && !HASH.test(value.verifierDigest)) throw new TypeError("Invalid composite binding identity");
  if (criterion && (value.criterionIndex !== criterion.criterionIndex || value.criterionId !== criterion.criterionId
    || value.criterionHash !== criterion.criterionHash)) throw new TypeError("Composite criterion binding mismatch");
  return Object.fromEntries(BASE_FIELDS.map(field => [field, value[field]]));
}
function responseBinding(value: any, nullable = false) {
  exact(value, RESPONSE_FIELDS, "response binding");
  const allNull = RESPONSE_FIELDS.every(field => value[field] === null);
  if (nullable && allNull) return Object.fromEntries(RESPONSE_FIELDS.map(field => [field, null]));
  if (!["assistant", "native-policy"].includes(value.origin) || !ID.test(value.entryId) || !HASH.test(value.digest)
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > 65_536
    || !ID.test(value.operationRef) || !ID.test(value.messageRequestId)) throw new TypeError("Invalid response identity");
  return Object.fromEntries(RESPONSE_FIELDS.map(field => [field, value[field]]));
}
const nullResponse = () => Object.fromEntries(RESPONSE_FIELDS.map(field => [field, null]));
export function sealCompositePlanContext({ key, contractText, declarations, binding, maxAttempts = 2 }: any) {
  key32(key);
  const declarationCopy = copy(declarations), compiled = compileCompositeContract(contractText, declarationCopy);
  if (compiled.criterionBinding !== "matched") throw new TypeError("Composite plan is not bound to the current criterion");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new TypeError("Invalid composite attempt budget");
  const context = { version: COMPOSITE_PLAN_CONTEXT_VERSION, contractText: JSON.stringify(compiled.contract), declarations: declarationCopy,
    binding: baseBinding(copy(binding), compiled.contract), maxAttempts };
  const contextText = JSON.stringify(context), contextDigest = sha(contextText);
  return freeze({ version: COMPOSITE_PLAN_CONTEXT_VERSION, contextText, contextDigest,
    signature: signed(key, COMPOSITE_PLAN_CONTEXT_VERSION, contextText) });
}
function openPlan(key: KeyObject, sealed: any) {
  exact(sealed, ["version", "contextText", "contextDigest", "signature"], "sealed composite context");
  if (sealed.version !== COMPOSITE_PLAN_CONTEXT_VERSION || typeof sealed.contextText !== "string"
    || sha(sealed.contextText) !== sealed.contextDigest || !authentic(key, COMPOSITE_PLAN_CONTEXT_VERSION, sealed.contextText, sealed.signature)) {
    throw new Error("Composite plan context is unauthenticated");
  }
  const context = JSON.parse(sealed.contextText);
  exact(context, ["version", "contractText", "declarations", "binding", "maxAttempts"], "composite plan context");
  if (context.version !== COMPOSITE_PLAN_CONTEXT_VERSION) throw new Error("Composite plan context version changed");
  const compiled = compileCompositeContract(context.contractText, context.declarations);
  if (compiled.criterionBinding !== "matched") throw new Error("Composite plan criterion is not current");
  context.binding = baseBinding(context.binding, compiled.contract);
  if (!Number.isSafeInteger(context.maxAttempts) || context.maxAttempts < 1 || context.maxAttempts > 8) throw new Error("Invalid composite attempt budget");
  return { context: freeze(context), compiled };
}
function privateFile(filePath: string, projectRoot: string) {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || !path.isAbsolute(projectRoot)) throw new TypeError("Canonical journal paths required");
  const root = fs.realpathSync.native(projectRoot), directory = path.dirname(filePath);
  if (fs.realpathSync.native(directory) !== directory) throw new Error("Composite journal directory is not canonical");
  const relative = path.relative(root, filePath);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Composite journal must be outside candidate project");
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error("Composite journal directory must be private");
  return root;
}
export function openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest, expectedHead }: any) {
  key32(key); privateFile(filePath, projectRoot);
  if (!HASH.test(contextDigest) || expectedHead !== undefined && !HASH.test(expectedHead)) throw new TypeError("Invalid journal identity");
  const domain = `${JOURNAL_VERSION}\0${filePath}\0${contextDigest}`;
  const envelope = (payload: any) => { const text = JSON.stringify(payload); return JSON.stringify({ payload, signature: signed(key, domain, text) }) + "\n"; };
  const writeAll = (fd: number, text: string) => { const bytes = Buffer.from(text); for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset); fs.fsyncSync(fd); };
  const anchor = openCompositeJournalAnchor({ anchorPath: `${filePath}.anchor.json`, filePath, contextDigest, key });
  if (!fs.existsSync(filePath) && !anchor.exists()) {
    const line = envelope({ version: JOURNAL_VERSION, sequence: 0, previous: null, contextDigest, nonce: randomUUID() });
    anchor.prepare(null, JSON.parse(line).signature, Buffer.from(line));
  }
  const appendAnchored = (line: Buffer, create: boolean) => {
    const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
      | (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : fs.constants.O_APPEND);
    const fd = fs.openSync(filePath, flags, 0o600);
    try { writeAll(fd, line.toString()); } finally { fs.closeSync(fd); }
    if (create) { const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
  };
  if (fs.existsSync(filePath)) anchor.repairPreparedTail();
  if (!fs.existsSync(filePath)) anchor.reconcile(false, null, appendAnchored);
  const identity = fs.lstatSync(filePath);
  if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid() || (identity.mode & 0o077) !== 0) throw new Error("Composite journal file is unsafe");
  let closed = false, trustedHead: string;
  function read() {
    if (closed) throw new Error("Composite journal is closed");
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let source: string;
    try {
      const stat = fs.fstatSync(fd);
      if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size < 1 || stat.size > MAX_BYTES) throw new Error("Composite journal identity changed");
      source = fs.readFileSync(fd, "utf8");
    } finally { fs.closeSync(fd); }
    if (!source.endsWith("\n")) throw new Error("Composite journal has an incomplete record");
    const lines = source.trimEnd().split("\n"); if (lines.length > MAX_EVENTS + 1) throw new Error("Composite journal event bound exceeded");
    let previous: string | null = null; const events: any[] = [];
    for (const [index, line] of lines.entries()) {
      const item = JSON.parse(line); exact(item, ["payload", "signature"], "journal envelope");
      const text = JSON.stringify(item.payload);
      if (!authentic(key, domain, text, item.signature)) throw new Error("Composite journal signature is invalid");
      if (index === 0) {
        exact(item.payload, ["version", "sequence", "previous", "contextDigest", "nonce"], "journal header");
        if (item.payload.version !== JOURNAL_VERSION || item.payload.sequence !== 0 || item.payload.previous !== null
          || item.payload.contextDigest !== contextDigest || !ID.test(item.payload.nonce)) throw new Error("Composite journal header is invalid");
      } else {
        exact(item.payload, ["sequence", "previous", "kind", "data"], "journal event");
        if (item.payload.sequence !== index || item.payload.previous !== previous || typeof item.payload.kind !== "string") throw new Error("Composite journal chain is invalid");
        events.push(freeze(copy(item.payload)));
      }
      previous = item.signature;
    }
    return { events, head: previous as string };
  }
  const initial = read(); anchor.reconcile(true, initial.head, appendAnchored);
  const anchored = read(); trustedHead = anchored.head;
  if (expectedHead !== undefined && anchored.head !== expectedHead) { closed = true; throw new Error("Composite journal rollback or wrong head observed"); }
  function snapshot() { const current = read(); if (current.head !== trustedHead) throw new Error("Composite journal changed outside this authority"); return current; }
  function append(kind: string, data: any) {
    if (!/^[a-z][a-z-]{0,63}$/.test(kind)) throw new TypeError("Invalid composite journal event kind");
    const current = snapshot(), payload = { sequence: current.events.length + 1, previous: current.head, kind, data: copy(data) };
    const line = envelope(payload);
    if (fs.lstatSync(filePath).size + Buffer.byteLength(line) > MAX_BYTES) throw new Error("Composite journal byte bound exceeded");
    const nextHead = JSON.parse(line).signature; anchor.prepare(current.head, nextHead, Buffer.from(line));
    const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try { writeAll(fd, line); } finally { fs.closeSync(fd); }
    anchor.commit(current.head, nextHead, Buffer.from(line)); trustedHead = nextHead;
    return freeze({ event: payload, head: trustedHead });
  }
  return Object.freeze({ version: JOURNAL_VERSION, filePath, anchorPath: anchor.anchorPath, contextDigest,
    events: () => snapshot().events, head: () => snapshot().head, append,
    close() { closed = true; } });
}
function factRecord(value: any, spec: any, base: any, response: any, aggregateScopeId: string) {
  exact(value, FACT_FIELDS, "composite fact record");
  if (value.schemaVersion !== COMPOSITE_FACT_RECORD_VERSION || value.factId !== spec.id || value.factSpecDigest !== spec.specDigest
    || value.kind !== spec.kind || value.producerId !== spec.producerId || value.producerDigest !== spec.producerDigest
    || value.ruleDigest !== spec.ruleDigest || !["pass", "fail", "unknown", "error"].includes(value.status)
    || !HASH.test(value.observationDigest) || !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 16
    || new Set(value.reasonCodes).size !== value.reasonCodes.length) throw new Error("Composite fact record identity is invalid");
  const allowed = value.status === "unknown" ? UNKNOWN : value.status === "error" ? ERRORS : value.status === "fail" ? FAILURES : new Set();
  if (value.reasonCodes.some((reason: unknown) => typeof reason !== "string" || !allowed.has(reason as string))
    || value.status === "fail" !== (typeof value.counterexampleRef === "string" && HASH.test(value.counterexampleRef))
    || value.status !== "fail" && value.counterexampleRef !== null) throw new Error("Composite fact disposition is invalid");
  const bindingFields = [...BASE_FIELDS, "aggregateScopeId", "factId", "attemptId", "response"];
  exact(value.binding, bindingFields, "composite fact binding");
  const boundBase = Object.fromEntries(BASE_FIELDS.map(field => [field, value.binding[field]]));
  if (JSON.stringify(baseBinding(boundBase)) !== JSON.stringify(base) || value.binding.aggregateScopeId !== aggregateScopeId
    || value.binding.factId !== spec.id || !ID.test(value.binding.attemptId)
    || JSON.stringify(responseBinding(value.binding.response, true)) !== JSON.stringify(response)) throw new Error("Composite fact binding is stale");
  return freeze(copy(value));
}
function normalizedObservation(value: any, settlement: boolean, prepared: any) {
  const fields = ["status", "observationDigest", "counterexampleRef", "reasonCodes", ...(settlement ? ["response"] : [])];
  exact(value, fields, "fact observation");
  if (settlement && JSON.stringify(responseBinding(value.response)) !== JSON.stringify(prepared.response)) throw new TypeError("Settlement response mismatch");
  return copy(value);
}
export function compositePublicationIdempotencyKey(contextDigest: string, response: any) {
  if (!HASH.test(contextDigest)) throw new TypeError("Invalid composite context digest");
  return sha(JSON.stringify([COMPOSITE_ASSURANCE_VERSION, contextDigest, responseBinding(response)]));
}
export function openCompositeAssuranceRuntime({ key, sealedContext, journal, currentBinding }: any) {
  key32(key);
  if (!journal || journal.contextDigest !== sealedContext?.contextDigest || typeof currentBinding !== "function") throw new TypeError("Invalid composite runtime dependencies");
  const { context, compiled } = openPlan(key, sealedContext), token = Symbol("composite-runtime"), facts = new Map(compiled.contract.facts.map((fact: any) => [fact.id, fact]));
  const aggregateScopeId = sha(JSON.stringify([context.binding.taskRunId, context.binding.criterionId, context.binding.criterionHash, sealedContext.contextDigest]));
  function current() {
    const value = baseBinding(copy(currentBinding()), compiled.contract);
    if (JSON.stringify(value) !== JSON.stringify(context.binding)) throw new Error("Current composite binding changed");
    return value;
  }
  function load() {
    const state: any = { attempts: new Map(), reservations: new Map(), records: new Map(), prepared: null, aggregate: null, completed: null, invalidated: null };
    const events = journal.events();
    for (const [index, event] of events.entries()) {
      const data = event.data;
      if (index === 0 && event.kind !== "context-opened") throw new Error("Composite context-opened event is missing");
      if (event.kind === "context-opened") {
        exact(data, ["contextDigest"], "context-opened event");
        if (index !== 0 || data.contextDigest !== sealedContext.contextDigest) throw new Error("Composite context journal mismatch");
      } else if (event.kind === "fact-reserved") {
        exact(data, ["factId", "attemptId", "attempt"], "fact reservation event");
        const spec: any = facts.get(data.factId), next = (state.attempts.get(data.factId) ?? 0) + 1;
        if (!spec || state.reservations.has(data.factId) || data.attempt !== next || next > context.maxAttempts || !ID.test(data.attemptId)
          || state.prepared && spec.stage === "content" || !state.prepared && spec.stage === "settlement" || state.invalidated || state.completed) throw new Error("Invalid fact reservation transition");
        state.attempts.set(data.factId, next); state.reservations.set(data.factId, data);
      } else if (event.kind === "fact-settled") {
        exact(data, ["factId", "attemptId", "record"], "fact settlement event");
        const reservation = state.reservations.get(data.factId), spec: any = facts.get(data.factId);
        if (!reservation || reservation.attemptId !== data.attemptId) throw new Error("Invalid fact settlement transition");
        const response = spec.stage === "settlement" ? state.prepared?.response : nullResponse();
        if (!response) throw new Error("Settlement preceded response preparation");
        state.records.set(data.factId, factRecord(data.record, spec, context.binding, response, aggregateScopeId)); state.reservations.delete(data.factId);
      } else if (event.kind === "fact-interrupted") {
        exact(data, ["factId", "attemptId"], "fact interruption event");
        const reservation = state.reservations.get(data.factId);
        if (!reservation || reservation.attemptId !== data.attemptId) throw new Error("Invalid fact interruption transition");
        state.reservations.delete(data.factId);
      } else if (event.kind === "response-prepared") {
        exact(data, ["idempotencyKey", "response", "contentDigest"], "response preparation event");
        if (state.prepared || state.invalidated || !HASH.test(data.idempotencyKey) || !HASH.test(data.contentDigest)) throw new Error("Invalid response preparation transition");
        const response = responseBinding(data.response), content = [...facts.values()].filter((fact: any) => fact.stage === "content");
        const contentDigest = sha(JSON.stringify(content.map((fact: any) => sha(JSON.stringify(state.records.get(fact.id))))));
        if (content.some((fact: any) => state.records.get(fact.id)?.status !== "pass") || data.contentDigest !== contentDigest
          || data.idempotencyKey !== compositePublicationIdempotencyKey(sealedContext.contextDigest, response)) throw new Error("Prepared response lacks current content facts");
        state.prepared = freeze({ ...data, response });
      } else if (event.kind === "aggregate-settled") {
        exact(data, ["idempotencyKey", "assessmentDigest", "taskPublicationDigest"], "aggregate settlement event");
        const assessmentDigest = sha(JSON.stringify([...facts.keys()].map(id => sha(JSON.stringify(state.records.get(id))))));
        if (!state.prepared || state.aggregate || state.invalidated || data.idempotencyKey !== state.prepared.idempotencyKey
          || !HASH.test(data.assessmentDigest) || data.assessmentDigest !== assessmentDigest || !HASH.test(data.taskPublicationDigest)
          || [...facts.values()].some((fact: any) => state.records.get(fact.id)?.status !== "pass")) throw new Error("Invalid aggregate settlement transition");
        state.aggregate = freeze(copy(data));
      } else if (event.kind === "task-completed") {
        exact(data, ["idempotencyKey", "assessmentDigest", "taskPublicationDigest"], "task completion event");
        if (!state.aggregate || state.completed || state.invalidated || JSON.stringify(data) !== JSON.stringify(state.aggregate)) throw new Error("Invalid task completion transition");
        state.completed = freeze(copy(data));
      } else if (event.kind === "invalidated") {
        exact(data, ["reason"], "invalidation event");
        if (state.invalidated || state.completed || !["cancelled", "superseded"].includes(data.reason)) throw new Error("Invalid composite invalidation transition");
        state.invalidated = data.reason;
      } else throw new Error("Unknown composite journal event");
    }
    if (events.length === 0) journal.append("context-opened", { contextDigest: sealedContext.contextDigest });
    return state;
  }
  load(); current();
  const issueFact = (factId: string, record: any) => {
    const receipt = freeze({ version: "composite-fact-capability-v1", factId, status: record.status, recordDigest: sha(JSON.stringify(record)) });
    factCapabilities.set(receipt, { token, factId, recordDigest: receipt.recordDigest }); return receipt;
  };
  const issuePreparation = (prepared: any) => {
    const receipt = freeze({ version: "composite-preparation-capability-v1", idempotencyKey: prepared.idempotencyKey, responseDigest: prepared.response.digest });
    preparationCapabilities.set(receipt, { token, idempotencyKey: prepared.idempotencyKey }); return receipt;
  };
  const issueAggregate = (aggregate: any) => {
    const receipt = freeze({ version: COMPOSITE_ASSURANCE_VERSION, verdict: "pass", completionAllowed: true, repairEligible: false,
      sourceMutationAllowed: false, assurance: COMPOSITE_ASSURANCE, idempotencyKey: aggregate.idempotencyKey,
      assessmentDigest: aggregate.assessmentDigest, taskPublicationDigest: aggregate.taskPublicationDigest });
    aggregateCapabilities.set(receipt, { token, idempotencyKey: aggregate.idempotencyKey,
      assessmentDigest: aggregate.assessmentDigest, taskPublicationDigest: aggregate.taskPublicationDigest }); return receipt;
  };
  function producerFor(factId: string) {
    const spec: any = facts.get(factId); if (!spec) throw new TypeError("Unknown composite fact");
    const capability = freeze({ version: "composite-producer-capability-v1", factId });
    producerCapabilities.set(capability, { token, factId, producerId: spec.producerId, producerDigest: spec.producerDigest, ruleDigest: spec.ruleDigest });
    return capability;
  }
  function reserveFact(factId: string, { retry = false } = {}) {
    current(); const state = load(), spec: any = facts.get(factId);
    if (!spec || state.invalidated || state.completed) throw new Error("Composite fact cannot be reserved");
    if (state.reservations.has(factId)) return freeze({ status: "pending", attemptId: state.reservations.get(factId).attemptId });
    if (state.records.has(factId) && !retry) return freeze({ status: "current", receipt: issueFact(factId, state.records.get(factId)) });
    const attempt = (state.attempts.get(factId) ?? 0) + 1;
    if (attempt > context.maxAttempts) return freeze({ status: "exhausted" });
    const data = { factId, attemptId: randomUUID(), attempt }; journal.append("fact-reserved", data);
    const reservation = freeze({ version: "composite-fact-reservation-v1", factId, attemptId: data.attemptId });
    reservationCapabilities.set(reservation, { token, ...data });
    return freeze({ status: "reserved", reservation });
  }
  async function settleFact({ reservation, producer, collect }: any) {
    const owned: any = reservationCapabilities.get(reservation), producerOwned: any = producerCapabilities.get(producer);
    if (!owned || owned.token !== token || !producerOwned || producerOwned.token !== token || producerOwned.factId !== owned.factId || typeof collect !== "function") {
      throw new Error("Untrusted composite fact capability");
    }
    const before = current(), state = load(), pending = state.reservations.get(owned.factId), spec: any = facts.get(owned.factId);
    if (!pending || pending.attemptId !== owned.attemptId) throw new Error("Composite fact reservation is not current");
    let observed: any;
    try { observed = await collect(); }
    catch { observed = { status: "error", observationDigest: sha("producer-crash"), counterexampleRef: null, reasonCodes: ["producer-crash"],
      ...(spec.stage === "settlement" ? { response: state.prepared?.response } : {}) }; }
    try { if (JSON.stringify(current()) !== JSON.stringify(before)) throw new Error("drift"); }
    catch { observed = { status: "unknown", observationDigest: sha("stale-binding"), counterexampleRef: null, reasonCodes: ["stale-binding"],
      ...(spec.stage === "settlement" ? { response: state.prepared?.response } : {}) }; }
    observed = normalizedObservation(observed, spec.stage === "settlement", state.prepared);
    const response = spec.stage === "settlement" ? state.prepared.response : nullResponse();
    const binding = { ...context.binding, aggregateScopeId, factId: spec.id, attemptId: owned.attemptId, response };
    const record = factRecord({ schemaVersion: COMPOSITE_FACT_RECORD_VERSION, factId: spec.id, factSpecDigest: spec.specDigest,
      kind: spec.kind, producerId: spec.producerId, producerDigest: spec.producerDigest, ruleDigest: spec.ruleDigest,
      binding, status: observed.status, observationDigest: observed.observationDigest, counterexampleRef: observed.counterexampleRef,
      reasonCodes: observed.reasonCodes }, spec, context.binding, response, aggregateScopeId);
    journal.append("fact-settled", { factId: spec.id, attemptId: owned.attemptId, record }); reservationCapabilities.delete(reservation);
    return issueFact(spec.id, record);
  }
  function reconcileInterrupted({ factId, attemptId, producerStopped = false }: any) {
    current(); const state = load(), reservation = state.reservations.get(factId);
    if (producerStopped !== true || !reservation || reservation.attemptId !== attemptId) throw new Error("Exact stopped producer reservation required");
    journal.append("fact-interrupted", { factId, attemptId });
  }
  function assess(receipts: any[], contentOnly = false) {
    try { current(); } catch { return decision("unknown", ["stale-binding"], [], [], false); }
    const state = load(), required = [...facts.values()].filter((fact: any) => !contentOnly || fact.stage === "content");
    if (!Array.isArray(receipts) || receipts.length > 16) return decision("unknown", ["untrusted-fact"], [], required.map((fact: any) => fact.id), false);
    const supplied = new Map(); let untrusted = false;
    for (const receipt of receipts) {
      const owned: any = factCapabilities.get(receipt), record = owned?.token === token ? state.records.get(owned.factId) : undefined;
      if (!owned || !record || owned.recordDigest !== sha(JSON.stringify(record)) || supplied.has(owned.factId)) untrusted = true;
      else supplied.set(owned.factId, record);
    }
    if (state.invalidated) return decision("unknown", [state.invalidated], [], required.map((fact: any) => fact.id), false);
    const missing = required.filter((fact: any) => !supplied.has(fact.id)).map((fact: any) => fact.id);
    if (untrusted) return decision("unknown", ["untrusted-fact", ...(missing.length ? ["missing-fact"] : [])], [], missing, false);
    const records = required.map((fact: any) => supplied.get(fact.id)).filter(Boolean);
    const by = (status: string) => records.filter((record: any) => record.status === status);
    const authorityUnknown = by("unknown").filter((record: any) => record.reasonCodes.some((reason: string) => ["invalid-approval", "stale-binding"].includes(reason)));
    if (authorityUnknown.length) return decision("unknown", authorityUnknown.flatMap((record: any) => record.reasonCodes), [], missing, false);
    if (by("error").length) return decision("error", by("error").flatMap((record: any) => record.reasonCodes), by("error").map((record: any) => record.factId), missing, false);
    if (by("fail").length) {
      const failed = by("fail"), safety = failed.some((record: any) => ["tool-policy-complete", "workspace-scope", "policy-refusal-output"].includes(record.kind));
      return decision("fail", failed.flatMap((record: any) => record.reasonCodes), failed.map((record: any) => record.factId), missing, !safety);
    }
    if (by("unknown").length || missing.length) return decision("unknown", [...by("unknown").flatMap((record: any) => record.reasonCodes), ...(missing.length ? ["missing-fact"] : [])], [], missing, false);
    return decision("pass", [contentOnly ? "all-content-facts-observed" : "all-required-facts-observed"], [], [], false);
  }
  function decision(verdict: string, reasons: string[], failedFactIds: string[], missingFactIds: string[], repairEligible: boolean) {
    return freeze({ version: COMPOSITE_ASSURANCE_VERSION, verdict, action: verdict === "error" ? "diagnose-producer" : verdict === "fail"
      ? repairEligible ? "repair-counterexample" : "safety-stop" : verdict === "unknown" ? "complete-facts" : "settle-aggregate",
    completionAllowed: false, repairEligible, sourceMutationAllowed: false, assurance: "none", reasons: [...new Set(reasons)], failedFactIds, missingFactIds });
  }
  function prepareResponse({ facts: receipts, bytes, origin, entryId, operationRef, messageRequestId, idempotencyKey }: any) {
    current(); const state = load();
    if (state.invalidated || state.completed) throw new Error("Composite publication is terminal");
    const buffer = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : typeof bytes === "string" ? Buffer.from(bytes) : null;
    if (!buffer || buffer.length > 65_536) throw new TypeError("Invalid actual response bytes");
    const response = responseBinding({ origin, entryId, digest: sha(buffer), byteLength: buffer.length, operationRef, messageRequestId });
    const expectedKey = compositePublicationIdempotencyKey(sealedContext.contextDigest, response);
    if (idempotencyKey !== undefined && idempotencyKey !== expectedKey) throw new Error("Composite publication idempotency mismatch");
    if (state.prepared) {
      if (state.prepared.idempotencyKey !== expectedKey || JSON.stringify(state.prepared.response) !== JSON.stringify(response)) throw new Error("Different response already prepared");
      return issuePreparation(state.prepared);
    }
    const assessment = assess(receipts, true); if (assessment.verdict !== "pass") throw new Error("Composite content facts are not prepared");
    for (const fact of facts.values() as any) if (fact.kind === "response-persisted" && !fact.parameters.expectedOrigins.includes(origin)) throw new Error("Response origin is not approved");
    if (origin === "native-policy" && [...facts.values()].some((fact: any) => fact.kind === "policy-refusal-output" && !HASH.test(fact.parameters.nativeTemplateSetDigest))) {
      throw new Error("Native response template is not pinned");
    }
    const contentDigest = sha(JSON.stringify([...facts.values()].filter((fact: any) => fact.stage === "content")
      .map((fact: any) => sha(JSON.stringify(state.records.get(fact.id))))));
    journal.append("response-prepared", { idempotencyKey: expectedKey, response, contentDigest });
    return issuePreparation(load().prepared);
  }
  function prepareAggregatePublication({ preparation, facts: receipts, taskPublicationDigest }: any) {
    current(); const prepared: any = preparationCapabilities.get(preparation), state = load();
    if (state.invalidated) throw new Error("Composite publication was invalidated");
    if (!prepared || prepared.token !== token || !state.prepared || prepared.idempotencyKey !== state.prepared.idempotencyKey
      || !HASH.test(taskPublicationDigest)) throw new Error("Untrusted aggregate publication preparation");
    const assessment = assess(receipts, false); if (assessment.verdict !== "pass") throw new Error("Composite aggregate is not satisfied");
    const aggregate = { idempotencyKey: state.prepared.idempotencyKey,
      assessmentDigest: sha(JSON.stringify([...facts.keys()].map(id => sha(JSON.stringify(state.records.get(id)))))),
      taskPublicationDigest };
    let preAggregateHead = journal.head();
    if (state.aggregate) {
      if (JSON.stringify(state.aggregate) !== JSON.stringify(aggregate)) throw new Error("Different aggregate publication already settled");
      const event = journal.events().find((item: any) => item.kind === "aggregate-settled");
      if (!event || !HASH.test(event.previous)) throw new Error("Aggregate publication head is unavailable");
      preAggregateHead = event.previous;
    }
    const publication = freeze({ version: "composite-aggregate-publication-capability-v1",
      taskPublicationDigest, assessmentDigest: aggregate.assessmentDigest });
    aggregatePreparationCapabilities.set(publication, { token, aggregate, preAggregateHead });
    const entry = freeze({ version: "composite-journal-publication-v1", criterionId: compiled.contract.criterionId,
      criterionHash: compiled.contract.criterionHash, contextDigest: sealedContext.contextDigest,
      journalFile: path.basename(journal.filePath), preAggregateHead, aggregate });
    return freeze({ publication, entry });
  }
  function settleAggregate({ publication }: any) {
    current(); const prepared: any = aggregatePreparationCapabilities.get(publication), state = load();
    if (!prepared || prepared.token !== token || state.invalidated) throw new Error("Untrusted aggregate publication");
    if (state.aggregate) {
      if (JSON.stringify(state.aggregate) !== JSON.stringify(prepared.aggregate)) throw new Error("Different aggregate already settled");
      return issueAggregate(state.aggregate);
    }
    if (journal.head() !== prepared.preAggregateHead) throw new Error("Aggregate publication head changed");
    current(); journal.append("aggregate-settled", prepared.aggregate);
    return issueAggregate(load().aggregate);
  }
  function prepareTaskCompletion({ aggregate }: any) {
    current(); const owned: any = aggregateCapabilities.get(aggregate), state = load();
    if (!owned || owned.token !== token || !state.aggregate || owned.idempotencyKey !== state.aggregate.idempotencyKey
      || owned.assessmentDigest !== state.aggregate.assessmentDigest
      || owned.taskPublicationDigest !== state.aggregate.taskPublicationDigest || state.invalidated) throw new Error("Untrusted composite aggregate");
    const publication = freeze({ version: "composite-task-publication-capability-v1",
      idempotencyKey: state.aggregate.idempotencyKey, assessmentDigest: state.aggregate.assessmentDigest,
      taskPublicationDigest: state.aggregate.taskPublicationDigest });
    publicationCapabilities.set(publication, { token, ...state.aggregate }); return publication;
  }
  function completeTask({ aggregate, publication }: any) {
    const owned: any = aggregateCapabilities.get(aggregate), published: any = publicationCapabilities.get(publication);
    if (!published) current();
    const state = load();
    if (!owned || owned.token !== token || !state.aggregate || owned.idempotencyKey !== state.aggregate.idempotencyKey
      || owned.assessmentDigest !== state.aggregate.assessmentDigest
      || owned.taskPublicationDigest !== state.aggregate.taskPublicationDigest || state.invalidated
      || published && (published.token !== token || published.idempotencyKey !== state.aggregate.idempotencyKey
        || published.assessmentDigest !== state.aggregate.assessmentDigest
        || published.taskPublicationDigest !== state.aggregate.taskPublicationDigest)) throw new Error("Untrusted composite aggregate");
    if (!state.completed) journal.append("task-completed", state.aggregate);
    if (publication) publicationCapabilities.delete(publication);
    return freeze({ completed: true, idempotencyKey: state.aggregate.idempotencyKey, assessmentDigest: state.aggregate.assessmentDigest,
      taskPublicationDigest: state.aggregate.taskPublicationDigest, responseDigest: state.prepared.response.digest,
      outputCreated: false, modelTurnRequested: false });
  }
  function invalidate(reason: string) {
    if (!["cancelled", "superseded"].includes(reason)) throw new TypeError("Invalid composite invalidation");
    const state = load(); if (state.completed) throw new Error("Completed composite cannot be invalidated");
    if (!state.invalidated) journal.append("invalidated", { reason });
  }
  function reissue() {
    current(); const state = load(), receipts = [...state.records].map(([id, record]) => issueFact(id, record));
    return freeze({ facts: receipts, preparation: state.prepared && !state.invalidated ? issuePreparation(state.prepared) : null,
      aggregate: state.aggregate && !state.invalidated ? issueAggregate(state.aggregate) : null,
      completed: Boolean(state.completed), invalidated: state.invalidated });
  }
  function state() {
    const value = load(); return freeze({ requiredFactIds: [...facts.keys()], factStatuses: Object.fromEntries([...value.records].map(([id, record]: any) => [id, record.status])),
      pendingFactIds: [...value.reservations.keys()], phase: value.completed ? "completed" : value.invalidated ?? (value.aggregate ? "settled" : value.prepared ? "prepared" : "collecting"),
      idempotencyKey: value.prepared?.idempotencyKey ?? null, journalHead: journal.head(), eventCount: journal.events().length });
  }
  return Object.freeze({ version: COMPOSITE_ASSURANCE_VERSION, compiled, producerFor, reserveFact, settleFact, reconcileInterrupted,
    assess: (receipts: any[]) => assess(receipts, false), assessContent: (receipts: any[]) => assess(receipts, true),
    prepareResponse, prepareAggregatePublication, settleAggregate, prepareTaskCompletion,
    completeTask, invalidate, reissue, state });
}
