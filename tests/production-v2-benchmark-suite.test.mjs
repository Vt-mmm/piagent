import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { benchmarkSuiteValidationErrors } from "../packages/piagent-core/benchmark/benchmark-suite.js";
import { loadBenchmarkSuite, validateBenchmarkSuiteFiles } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { executionOrder } from "../scripts/benchmark-runner-support.mjs";

const root = path.resolve(import.meta.dirname, "..");
const loaded = loadBenchmarkSuite("production-v2", root);
const { suite, suiteRoot } = loaded;
const productionV1ScenarioIds = new Set(loadBenchmarkSuite("production-v1", root).suite.scenarios.map((scenario) => scenario.id));
const deepScenarioIds = new Set([
  "revoked-session-cache", "billing-cutoff-clock-skew", "abort-reconnect-supersession",
  "chunked-record-boundary", "idempotent-replay-conflict", "resumable-checkpoint-partial-failure",
  "backend-frontend-contract-sync", "workflow-switch-same-session", "reconnect-chat-event-order"
]);

function generate(workspace, scenario, oraclePath, seed = `production-v2-${scenario.id}`) {
  const result = spawnSync(process.execPath, [path.join(suiteRoot, scenario.variantGenerator), workspace, oraclePath, seed, scenario.id], { encoding: "utf8" });
  assert.equal(result.status, 0, `${scenario.id} variant failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(oraclePath, "utf8"));
}

function grade(workspace, scenario, oraclePath) {
  const result = spawnSync(process.execPath, [path.join(suiteRoot, scenario.grader), workspace, oraclePath], {
    encoding: "utf8", env: { ...process.env, PIAGENT_BENCHMARK_SCENARIO: scenario.id }
  });
  assert.equal(result.status, 0, `${scenario.id} grader failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

const references = {
  "revoked-session-cache": ["src/backend/revocation-cache.js", `
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && value.length > 0; }
function integer(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function isCachedAccessUsable(entry, request) {
  if (!object(entry) || !object(request)
    || ![entry.tenantId, entry.userId, entry.capability, request.tenantId, request.userId, request.capability].every(id)
    || ![entry.permissionRevision, entry.evaluatedAt, entry.expiresAt, request.currentPermissionRevision, request.now].every(integer)
    || (request.revokedAt !== null && !integer(request.revokedAt))) throw new TypeError("invalid cached access input");
  return entry.tenantId === request.tenantId
    && entry.userId === request.userId
    && entry.capability === request.capability
    && entry.permissionRevision === request.currentPermissionRevision
    && entry.evaluatedAt <= request.now
    && request.now < entry.expiresAt
    && !(request.revokedAt !== null && request.revokedAt <= request.now);
}
`],
  "billing-cutoff-clock-skew": ["src/backend/billing-window.js", `
function integer(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function billingBucket(event, period) {
  if (!event || typeof event !== "object" || !period || typeof period !== "object"
    || ![event.occurredAt, event.receivedAt, period.startsAt, period.endsAt, period.maxClockSkewMs].every(integer)
    || period.maxClockSkewMs < 0 || period.startsAt >= period.endsAt) throw new TypeError("invalid billing window");
  if (event.occurredAt < period.startsAt || event.occurredAt >= period.endsAt) return "outside";
  if (event.receivedAt < event.occurredAt - period.maxClockSkewMs) return "invalid-clock";
  if (event.receivedAt >= period.endsAt + period.maxClockSkewMs) return "late";
  return "current";
}
`],
  "abort-reconnect-supersession": ["src/frontend/request-lifecycle.js", `
export const initialRequestState = Object.freeze({ activeRequestId: null, connectionEpoch: 0, loading: false, results: [], error: null });
export function requestLifecycleReducer(state = initialRequestState, action) {
  if (action.type === "connection/reconnect") {
    if (!Number.isInteger(action.epoch) || action.epoch <= state.connectionEpoch) return state;
    return { ...state, activeRequestId: null, connectionEpoch: action.epoch, loading: false, error: null };
  }
  if (action.type === "request/start") {
    if (!Number.isInteger(action.epoch) || action.epoch < state.connectionEpoch) return state;
    return { ...state, activeRequestId: action.requestId, connectionEpoch: action.epoch, loading: true, error: null };
  }
  if (action.type === "request/success") {
    if (action.requestId !== state.activeRequestId || action.epoch !== state.connectionEpoch) return state;
    return { ...state, activeRequestId: null, loading: false, results: [...action.results], error: null };
  }
  if (action.type === "request/failure") {
    if (action.requestId !== state.activeRequestId || action.epoch !== state.connectionEpoch) return state;
    return { ...state, activeRequestId: null, loading: false, error: action.error };
  }
  return state;
}
`],
  "chunked-record-boundary": ["src/data/ndjson-stream.js", `
export function parseNdjsonChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.some((chunk) => !(chunk instanceof Uint8Array))) throw new TypeError("chunks must be Uint8Array values");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = []; let pending = "";
  const consume = (final = false) => {
    const lines = pending.split("\\n");
    pending = final ? "" : lines.pop();
    if (final && lines.length === 0) lines.push(pending);
    for (let line of lines) {
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      if (line.length > 0) records.push(JSON.parse(line));
    }
  };
  for (const chunk of chunks) { pending += decoder.decode(chunk, { stream: true }); consume(false); }
  pending += decoder.decode(); consume(true);
  return records;
}
`],
  "idempotent-replay-conflict": ["src/data/versioned-replay.js", `
function record(value) { return value && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && value.length > 0; }
export function replayVersionedEvents(initial, events) {
  if (!record(initial) || !record(initial.entities) || !Array.isArray(initial.appliedEventIds)
    || initial.appliedEventIds.some((value) => !id(value)) || !Array.isArray(events)) throw new TypeError("invalid replay input");
  const output = structuredClone(initial); const applied = new Set(output.appliedEventIds);
  for (const event of events) {
    if (!record(event) || !id(event.eventId) || !id(event.entityId) || !Number.isInteger(event.expectedVersion) || event.expectedVersion < 0) throw new TypeError("invalid event");
    if (applied.has(event.eventId)) continue;
    const current = output.entities[event.entityId];
    if (current !== undefined && (!record(current) || !Number.isInteger(current.version) || current.version < 0)) throw new TypeError("invalid entity");
    const version = current?.version ?? 0;
    if (version !== event.expectedVersion) throw new Error("version conflict");
    output.entities[event.entityId] = { version: version + 1, value: structuredClone(event.nextValue) };
    output.appliedEventIds.push(event.eventId); applied.add(event.eventId);
  }
  return output;
}
`],
  "resumable-checkpoint-partial-failure": ["src/reliability/checkpoint.js", `
export async function resumeWork(items, checkpoint, processItem) {
  if (!Array.isArray(items) || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
    || !Number.isInteger(checkpoint.nextIndex) || checkpoint.nextIndex < 0 || checkpoint.nextIndex > items.length
    || !Array.isArray(checkpoint.results) || checkpoint.results.length !== checkpoint.nextIndex || typeof processItem !== "function") throw new TypeError("invalid checkpoint");
  const results = structuredClone(checkpoint.results);
  for (let index = checkpoint.nextIndex; index < items.length; index += 1) {
    try { results.push(await processItem(items[index], index)); }
    catch (error) { error.checkpoint = { nextIndex: index, results: structuredClone(results) }; throw error; }
  }
  return { nextIndex: items.length, results };
}
`],
  "backend-frontend-contract-sync": ["src/fullstack/contract-sync.js", `
function values(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item) || new Set(value).size !== value.length) throw new TypeError(label);
  return value;
}
function sort(values) { return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))); }
export function compareSubscriptionContracts(backend, frontend) {
  if (!backend || !frontend || !Number.isInteger(backend.version) || backend.version < 1 || !Number.isInteger(frontend.version) || frontend.version < 1) throw new TypeError("invalid version");
  const backendStatuses = values(backend.statuses, "backend statuses"); const frontendStatuses = values(frontend.statuses, "frontend statuses");
  const backendFields = values(backend.requiredFields, "backend fields"); const frontendFields = values(frontend.fields, "frontend fields");
  const missingStatuses = sort(backendStatuses.filter((value) => !frontendStatuses.includes(value)));
  const extraStatuses = sort(frontendStatuses.filter((value) => !backendStatuses.includes(value)));
  const missingFields = sort(backendFields.filter((value) => !frontendFields.includes(value)));
  const versionMismatch = backend.version !== frontend.version;
  return { compatible: missingStatuses.length === 0 && extraStatuses.length === 0 && missingFields.length === 0 && !versionMismatch, missingStatuses, extraStatuses, missingFields, versionMismatch };
}
`],
  "workflow-switch-same-session": ["src/platform/workflow-session.js", `
export const initialWorkflowSession = Object.freeze({ currentWorkflow: null, messages: [] });
function id(value) { return typeof value === "string" && value.length > 0; }
export function reduceWorkflowSession(state = initialWorkflowSession, event) {
  if (!state || typeof state !== "object" || !Array.isArray(state.messages) || !event || typeof event !== "object") throw new TypeError("invalid workflow state");
  if (event.type === "workflow/select") {
    if (!id(event.workflow)) throw new TypeError("invalid workflow");
    return { ...state, currentWorkflow: event.workflow };
  }
  if (event.type === "message/accepted") {
    if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");
    const hasWorkflowOverride = Object.hasOwn(event, "workflow");
    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");
    if (state.messages.some((message) => message.id === event.id)) return state;
    const workflow = hasWorkflowOverride ? event.workflow : state.currentWorkflow;
    if (!id(workflow)) throw new TypeError("missing workflow");
    return { currentWorkflow: workflow, messages: [...state.messages, { id: event.id, text: event.text, workflow }] };
  }
  return state;
}
`],
  "reconnect-chat-event-order": ["src/frontend/chat-events.js", `
function id(value) { return typeof value === "string" && value.length > 0; }
function messageContent(event) { return JSON.stringify([event.role, event.text, event.replyTo ?? null]); }
export function projectChatEvents(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const byEvent = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || !id(event.eventId) || !Number.isInteger(event.sequence) || event.sequence < 0) throw new TypeError("invalid event");
    const prior = byEvent.get(event.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("event conflict");
    if (!prior) byEvent.set(event.eventId, event);
  }
  const lifecycle = []; const byMessage = new Map();
  for (const event of byEvent.values()) {
    if (event.kind === "lifecycle") {
      if (!["started", "settled"].includes(event.state)) throw new TypeError("invalid lifecycle");
      lifecycle.push(event); continue;
    }
    if (event.kind !== "message" || !id(event.messageId) || !["user", "assistant"].includes(event.role) || typeof event.text !== "string" || typeof event.confirmed !== "boolean" || (event.replyTo !== undefined && !id(event.replyTo))) throw new TypeError("invalid message");
    const prior = byMessage.get(event.messageId);
    if (!prior || (!prior.confirmed && event.confirmed)) byMessage.set(event.messageId, event);
    else if (prior.confirmed && event.confirmed) {
      if (messageContent(prior) !== messageContent(event)) throw new Error("confirmed message conflict");
      if (event.sequence < prior.sequence) byMessage.set(event.messageId, event);
    }
  }
  const messages = [...byMessage.values()].sort((left, right) => left.sequence - right.sequence).map((event) => {
    const value = { messageId: event.messageId, role: event.role, text: event.text, sequence: event.sequence, confirmed: event.confirmed };
    if (event.replyTo !== undefined) value.replyTo = event.replyTo;
    return value;
  });
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]; if (!message.replyTo) continue;
    const parent = messages.findIndex((item) => item.messageId === message.replyTo);
    if (parent >= index) { messages.splice(index, 1); messages.splice(parent, 0, message); index = -1; }
  }
  lifecycle.sort((left, right) => left.sequence - right.sequence);
  return { messages, processing: lifecycle.at(-1)?.state === "started" };
}
`]
};

test("production-v2 is a self-contained 9 x 3 x 2 x 2 built-in matrix", () => {
  assert.equal(loaded.builtInId, "production-v2");
  assert.doesNotThrow(() => validateBenchmarkSuiteFiles(suite, suiteRoot));
  assert.deepEqual(suite.matrixContract, {
    schemaVersion: 1, familyCount: 9, variantsPerFamily: 3,
    variantRoles: ["boundary", "interaction", "adversarial-recovery"],
    surfaces: ["piagent", "codex-cli"], repeatsPerVariant: 2,
    expectedPairs: 54, expectedSessions: 108, confidenceSampleUnit: "task-family"
  });
  assert.equal(suite.scenarios.length, 27);
  assert.equal(suite.defaultRepeats, 2);
  assert.equal(suite.releaseGate.requireEfficiencyClaim, true, "hierarchical task-family aggregation is claim eligible");
  assert.equal(suite.releaseGate.minimumComparableEfficiencyScenarios, 9);
  const families = Map.groupBy(suite.scenarios, (scenario) => scenario.familyId);
  assert.equal(families.size, 9);
  for (const scenarios of families.values()) {
    assert.equal(scenarios.length, 3);
    assert.deepEqual(new Set(scenarios.map((scenario) => scenario.variantRole)), new Set(suite.matrixContract.variantRoles));
  }
  assert.equal(deepScenarioIds.size, 9);
  assert.equal(suite.scenarios.filter((scenario) => deepScenarioIds.has(scenario.id)).length, 9);
  assert.deepEqual(
    new Set(suite.scenarios.filter((scenario) => !deepScenarioIds.has(scenario.id)).map((scenario) => scenario.id)),
    productionV1ScenarioIds,
    "production-v2 must preserve all 18 production-v1 scenarios"
  );
});

test("matrix execution order covers every structural variant, repeat, surface and family exactly", () => {
  const order = executionOrder(suite, suite.defaultRepeats, suite.executionContract.surfaces, "production-v2-order-test");
  assert.equal(order.length, 108);
  const observed = new Set(order.map((item) => `${item.scenario.id}\0${item.repeat}\0${item.surface}`));
  assert.equal(observed.size, 108);
  for (let index = 0; index < order.length; index += 2) {
    const pair = order.slice(index, index + 2);
    assert.equal(pair[0].scenario.id, pair[1].scenario.id);
    assert.equal(pair[0].repeat, pair[1].repeat);
    assert.deepEqual(new Set(pair.map((item) => item.surface)), new Set(suite.executionContract.surfaces));
  }
  const byFamily = Map.groupBy(order, (item) => item.scenario.familyId);
  assert.equal(byFamily.size, 9);
  for (const attempts of byFamily.values()) assert.equal(attempts.length, 12);
});

test("matrix validator rejects cardinality, role and model-backed journey drift", () => {
  const invalid = structuredClone(suite);
  invalid.matrixContract.expectedSessions = 107;
  invalid.scenarios[0].userJourney.turns[0].workflow = "Not bounded";
  invalid.scenarios[1].userJourney.turns = invalid.scenarios[1].userJourney.turns.slice(1);
  invalid.scenarios[2].userJourney.turns[1].reconnectBefore = false;
  invalid.scenarios[2].userJourney.turns[1].receiptUncertain = "yes";
  invalid.scenarios[3].familyId = invalid.scenarios[0].familyId;
  const errors = benchmarkSuiteValidationErrors(invalid).join("; ");
  assert.match(errors, /expectedSessions does not match/);
  assert.match(errors, /workflow must be a bounded/);
  assert.match(errors, /interaction journey must contain scout, implement, verify/);
  assert.match(errors, /adversarial-recovery journey must exercise reconnect recovery/);
  assert.match(errors, /receiptUncertain must be a boolean/);
  assert.match(errors, /matrix family/);
  const missingMatrix = structuredClone(suite); missingMatrix.matrixContract = null;
  assert.doesNotThrow(() => benchmarkSuiteValidationErrors(missingMatrix));
  assert.match(benchmarkSuiteValidationErrors(missingMatrix).join("; "), /matrixContract must be an object/);
  const malformedRoles = structuredClone(suite); malformedRoles.matrixContract.variantRoles = 3;
  assert.doesNotThrow(() => benchmarkSuiteValidationErrors(malformedRoles));
  assert.match(benchmarkSuiteValidationErrors(malformedRoles).join("; "), /variantRoles must contain/);
  const legacySchema = structuredClone(suite); legacySchema.schemaVersion = 1;
  assert.match(benchmarkSuiteValidationErrors(legacySchema).join("; "), /matrixContract requires suite schemaVersion 2/);
  const missingContract = structuredClone(suite); delete missingContract.matrixContract;
  assert.match(benchmarkSuiteValidationErrors(missingContract).join("; "), /matrix metadata requires matrixContract/);
  const invalidReceiptPlacement = structuredClone(suite);
  invalidReceiptPlacement.scenarios[0].userJourney.turns[0].receiptUncertain = true;
  invalidReceiptPlacement.scenarios[0].userJourney.turns[0].reconnectBefore = true;
  assert.match(benchmarkSuiteValidationErrors(invalidReceiptPlacement).join("; "),
    /receiptUncertain requires an existing-session turn/);
});

test("every journey prompt exists, stays public, and records settlement plus workflow-switch examples", () => {
  for (const scenario of suite.scenarios) {
    const main = fs.readFileSync(path.join(suiteRoot, scenario.prompt), "utf8");
    assert.ok(main.trim().length > 40, `${scenario.id} must disclose its public semantic contract`);
    for (const turn of scenario.userJourney.turns) {
      const content = fs.readFileSync(path.join(suiteRoot, turn.prompt), "utf8");
      assert.ok(content.trim().length > 40, `${scenario.id}/${turn.id} journey prompt is empty`);
    }
    assert.equal(scenario.userJourney.expectedTerminalSettlement, scenario.kind === "safety-refusal" ? "refused" : "completed");
  }
  const workflow = suite.scenarios.find((scenario) => scenario.id === "workflow-switch-same-session");
  assert.deepEqual(workflow.userJourney.turns.map((turn) => turn.workflow), ["scout", "platform-improve", "review"]);
  const recovery = suite.scenarios.find((scenario) => scenario.id === "reconnect-chat-event-order");
  assert.deepEqual(recovery.userJourney.turns.map((turn) => turn.workflow), ["task", "review"]);
  assert.equal(recovery.userJourney.turns[1].reconnectBefore, true);
  assert.equal(recovery.userJourney.turns[1].receiptUncertain, true);
  for (const [id, pattern] of [
    ["revoked-session-cache", /permission revision[\s\S]*revocation/],
    ["billing-cutoff-clock-skew", /half-open[\s\S]*invalid-clock/],
    ["abort-reconnect-supersession", /request id and epoch/],
    ["chunked-record-boundary", /multi-byte character[\s\S]*CRLF/],
    ["idempotent-replay-conflict", /idempotent[\s\S]*version conflict/],
    ["resumable-checkpoint-partial-failure", /never process an earlier item\s+again/],
    ["backend-frontend-contract-sync", /missingStatuses[\s\S]*versionMismatch/],
    ["workflow-switch-same-session", /workflow\/select[\s\S]*non-empty string[\s\S]*own `workflow` property[\s\S]*validate[\s\S]*duplicate/i],
    ["reconnect-chat-event-order", /prefer the confirmed copy[\s\S]*old start cannot/]
  ]) assert.match(fs.readFileSync(path.join(suiteRoot, `prompts/${id}.md`), "utf8"), pattern);
});

test("all private variants generate and initial fixtures preserve the expected hidden acceptance boundary", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-v2-initial-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  for (const scenario of suite.scenarios) {
    const workspace = path.join(temporaryRoot, scenario.id); const oraclePath = `${workspace}.oracle.json`;
    fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
    const oracle = generate(workspace, scenario, oraclePath);
    assert.equal(oracle.schemaVersion, 1);
    assert.ok(oracle.graderData && Object.keys(oracle.graderData).length > 0);
    assert.equal(fs.statSync(oraclePath).mode & 0o777, 0o600);
    const result = grade(workspace, scenario, oraclePath);
    assert.equal(result.passed, scenario.kind !== "source-change", `${scenario.id} initial acceptance boundary drifted`);
  }
});

test("every new deep variant rejects its regression and accepts an independent reference", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-v2-reference-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  for (const scenario of suite.scenarios.filter((item) => deepScenarioIds.has(item.id))) {
    const workspace = path.join(temporaryRoot, scenario.id); const oraclePath = `${workspace}.oracle.json`;
    fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
    generate(workspace, scenario, oraclePath, `reference-${scenario.id}`);
    assert.equal(grade(workspace, scenario, oraclePath).passed, false, `${scenario.id} must start with a real regression`);
    const [relativePath, source] = references[scenario.id];
    fs.writeFileSync(path.join(workspace, relativePath), source.trimStart());
    const result = grade(workspace, scenario, oraclePath);
    assert.equal(result.passed, true, `${scenario.id} reference failed: ${JSON.stringify(result)}`);
  }
});

test("workflow-switch grader rejects nullish, precedence, identity, and mutation regressions", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-v2-workflow-mutants-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const scenario = suite.scenarios.find((item) => item.id === "workflow-switch-same-session");
  const [relativePath, reference] = references[scenario.id];
  const overrideValidation = [
    '    const hasWorkflowOverride = Object.hasOwn(event, "workflow");',
    '    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");'
  ].join("\n");
  const duplicateCheck = "    if (state.messages.some((message) => message.id === event.id)) return state;";
  const mutants = {
    "nullish-fallback": reference
      .replace(`${overrideValidation}\n`, "")
      .replace("const workflow = hasWorkflowOverride ? event.workflow : state.currentWorkflow;", "const workflow = event.workflow ?? state.currentWorkflow;"),
    "duplicate-before-validation": reference.replace(
      `${overrideValidation}\n${duplicateCheck}`,
      `${duplicateCheck}\n${overrideValidation}`
    ),
    "payload-only-duplicate": reference.replace(
      "message.id === event.id)",
      "message.id === event.id && message.text === event.text)"
    ),
    "differing-workflow-duplicate": reference.replace(
      "message.id === event.id)",
      "message.id === event.id && (!Object.hasOwn(event, 'workflow') || event.workflow === message.workflow))"
    ),
    "partial-duplicate-validation": reference
      .replace(
        'if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");',
        'if (!id(event.id) || event.text === "") throw new TypeError("invalid message");'
      )
      .replace(
        'if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");',
        'if (hasWorkflowOverride && (event.workflow === null || event.workflow === undefined)) throw new TypeError("invalid workflow override");'
      )
      .replace(
        duplicateCheck,
        `${duplicateCheck}\n    if (!id(event.text)) throw new TypeError("invalid message");\n    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");`
      ),
    "message-id-non-string": reference.replace(
      'if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");',
      'if (!Object.hasOwn(event, "id") || event.id === "" || typeof event.id === "number" || !id(event.text)) throw new TypeError("invalid message");'
    ),
    "duplicate-before-nullish-text-validation": reference
      .replace(
        'if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");',
        'if (!id(event.id) || !Object.hasOwn(event, "text") || event.text === "" || typeof event.text === "number" || (typeof event.text === "object" && event.text !== null)) throw new TypeError("invalid message");'
      )
      .replace(
        duplicateCheck,
        `${duplicateCheck}\n    if (!id(event.text)) throw new TypeError("invalid message");`
      ),
    "invalid-clones-messages-before-throw": reference.replace(
      'if (!id(event.workflow)) throw new TypeError("invalid workflow");',
      'if (!id(event.workflow)) { state.messages = [...state.messages]; throw new TypeError("invalid workflow"); }'
    ),
    "missing-active-workflow-check": reference.replace(
      '    if (!id(workflow)) throw new TypeError("missing workflow");\n',
      ""
    ),
    "active-workflow-before-duplicate": reference.replace(
      `${duplicateCheck}\n    const workflow = hasWorkflowOverride ? event.workflow : state.currentWorkflow;\n    if (!id(workflow)) throw new TypeError("missing workflow");`,
      `    const workflow = hasWorkflowOverride ? event.workflow : state.currentWorkflow;\n    if (!id(workflow)) throw new TypeError("missing workflow");\n${duplicateCheck}`
    ),
    "workflow-select-drops-metadata": reference.replace(
      'return { ...state, currentWorkflow: event.workflow };',
      'return { currentWorkflow: event.workflow, messages: state.messages };'
    ),
    "workflow-select-clones-messages": reference.replace(
      'return { ...state, currentWorkflow: event.workflow };',
      'return { ...state, currentWorkflow: event.workflow, messages: [...state.messages] };'
    ),
    "workflow-select-clones-only-empty-messages": reference.replace(
      'return { ...state, currentWorkflow: event.workflow };',
      'return { ...state, currentWorkflow: event.workflow, messages: state.messages.length === 0 ? [...state.messages] : state.messages };'
    ),
    "workflow-select-drops-empty-state-metadata": reference.replace(
      'return { ...state, currentWorkflow: event.workflow };',
      'return state.messages.length === 0 ? { currentWorkflow: event.workflow, messages: state.messages } : { ...state, currentWorkflow: event.workflow };'
    ),
    "deduplicates-only-first-message": reference.replace(
      'state.messages.some((message) => message.id === event.id)',
      'state.messages[0]?.id === event.id'
    ),
    "deduplicates-only-first-or-last-message": reference.replace(
      'state.messages.some((message) => message.id === event.id)',
      'state.messages[0]?.id === event.id || state.messages.at(-1)?.id === event.id'
    ),
    "deduplicates-only-edge-and-middle-message": reference.replace(
      'state.messages.some((message) => message.id === event.id)',
      'state.messages[0]?.id === event.id || state.messages[Math.floor(state.messages.length / 2)]?.id === event.id || state.messages.at(-1)?.id === event.id'
    ),
    "case-insensitive-message-id": reference.replace(
      'message.id === event.id',
      'message.id.toLowerCase() === event.id.toLowerCase()'
    ),
    "duplicate-boolean-override-before-validation": reference
      .replace(
        'if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");',
        'if (hasWorkflowOverride && (event.workflow === null || event.workflow === undefined || typeof event.workflow === "number" || typeof event.workflow === "object")) throw new TypeError("invalid workflow override");'
      )
      .replace(
        duplicateCheck,
        `${duplicateCheck}\n    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");`
      ),
    "late-exotic-text-validation": reference
      .replace(
        'if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");',
        'const deferTextValidation = ["bigint", "symbol", "function"].includes(typeof event.text) || (event.text && typeof event.text === "object" && event.text.length === 1);\n    if (!id(event.id) || (!id(event.text) && !deferTextValidation)) throw new TypeError("invalid message");'
      )
      .replace(
        duplicateCheck,
        `${duplicateCheck}\n    if (!id(event.text)) throw new TypeError("invalid message");`
      ),
    "late-exotic-override-validation": reference
      .replace(
        'if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");',
        'const deferWorkflowValidation = hasWorkflowOverride && (["bigint", "symbol", "function"].includes(typeof event.workflow) || (event.workflow && typeof event.workflow === "object" && event.workflow.length === 1));\n    if (hasWorkflowOverride && !id(event.workflow) && !deferWorkflowValidation) throw new TypeError("invalid workflow override");'
      )
      .replace(
        duplicateCheck,
        `${duplicateCheck}\n    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");`
      ),
    "length-based-string-validator": reference.replace(
      'function id(value) { return typeof value === "string" && value.length > 0; }',
      'function id(value) { return value != null && value.length > 0; }'
    ),
    "direct-event-has-own-property": reference.replace(
      'const hasWorkflowOverride = Object.hasOwn(event, "workflow");',
      'const hasWorkflowOverride = event.hasOwnProperty("workflow");'
    ),
    "enumerable-only-workflow-override": reference.replace(
      'const hasWorkflowOverride = Object.hasOwn(event, "workflow");',
      'const hasWorkflowOverride = Object.keys(event).includes("workflow");'
    ),
    "mutates-inherited-workflow-prototype": reference.replace(
      `${overrideValidation}\n`,
      `${overrideValidation}\n    if (!hasWorkflowOverride && "workflow" in event) delete Object.getPrototypeOf(event).workflow;\n`
    ),
    "active-workflow-nullish-only": reference.replace(
      'if (!id(workflow)) throw new TypeError("missing workflow");',
      'if (workflow == null) throw new TypeError("missing workflow");'
    ),
    "missing-active-mutates-and-returns": reference.replace(
      'if (!id(workflow)) throw new TypeError("missing workflow");',
      'if (!id(workflow)) { state.messages.push({ id: event.id, text: event.text, workflow }); return state; }'
    ),
    "freezes-valid-events": reference
      .replace(
        'if (!id(event.workflow)) throw new TypeError("invalid workflow");',
        'if (!id(event.workflow)) throw new TypeError("invalid workflow");\n    Object.freeze(event);'
      )
      .replace(
        'if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");',
        'if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");\n    Object.freeze(event);'
      ),
    "global-current-workflow-validation": reference.replace(
      'if (!state || typeof state !== "object" || !Array.isArray(state.messages) || !event || typeof event !== "object") throw new TypeError("invalid workflow state");',
      'if (!state || typeof state !== "object" || !Array.isArray(state.messages) || !event || typeof event !== "object") throw new TypeError("invalid workflow state");\n  if (state.currentWorkflow !== null && !id(state.currentWorkflow)) throw new TypeError("invalid current workflow");'
    ),
    "drops-default-initial-state": reference.replace(
      'reduceWorkflowSession(state = initialWorkflowSession, event)',
      'reduceWorkflowSession(state, event)'
    ),
    "defaults-only-workflow-select": reference
      .replace(
        'reduceWorkflowSession(state = initialWorkflowSession, event)',
        'reduceWorkflowSession(state, event)'
      )
      .replace(
        'if (!state || typeof state !== "object" || !Array.isArray(state.messages) || !event || typeof event !== "object") throw new TypeError("invalid workflow state");',
        'state = state ?? (event?.type === "workflow/select" ? initialWorkflowSession : state);\n  if (!state || typeof state !== "object" || !Array.isArray(state.messages) || !event || typeof event !== "object") throw new TypeError("invalid workflow state");'
      ),
    "workflow-select-validates-prior-current": reference.replace(
      'if (event.type === "workflow/select") {',
      'if (event.type === "workflow/select") {\n    if (state.currentWorkflow !== null && !id(state.currentWorkflow)) throw new TypeError("invalid current workflow");'
    ),
    "mutating-append": reference.replace(
      "return { currentWorkflow: workflow, messages: [...state.messages, { id: event.id, text: event.text, workflow }] };",
      "state.currentWorkflow = workflow; state.messages.push({ id: event.id, text: event.text, workflow }); return state;"
    ),
    "mutation-on-invalid": reference
      .replace(
        'if (!id(event.workflow)) throw new TypeError("invalid workflow");',
        "if (!id(event.workflow)) { state.currentWorkflow = event.workflow; return state; }"
      )
      .replace(
        'if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");',
        "if (!id(event.id) || !id(event.text)) { state.currentWorkflow = event.workflow; return state; }"
      )
      .replace(
        'if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");',
        "if (hasWorkflowOverride && !id(event.workflow)) { state.currentWorkflow = event.workflow; return state; }"
      ),
    "trim-non-empty": reference.replace(
      'function id(value) { return typeof value === "string" && value.length > 0; }',
      'function id(value) { return typeof value === "string" && value.trim().length > 0; }'
    )
  };
  const expectedFailedCheck = {
    "nullish-fallback": "message-event-validation",
    "duplicate-before-validation": "message-event-validation",
    "payload-only-duplicate": "workflow-switch-preserves-and-attributes-messages",
    "differing-workflow-duplicate": "workflow-switch-preserves-and-attributes-messages",
    "partial-duplicate-validation": "message-event-validation",
    "message-id-non-string": "message-event-validation",
    "duplicate-before-nullish-text-validation": "message-event-validation",
    "invalid-clones-messages-before-throw": "workflow-select-validation",
    "missing-active-workflow-check": "duplicate-precedes-active-workflow-validation",
    "active-workflow-before-duplicate": "duplicate-precedes-active-workflow-validation",
    "workflow-select-drops-metadata": "workflow-select-validation",
    "workflow-select-clones-messages": "workflow-select-validation",
    "workflow-select-clones-only-empty-messages": "workflow-switch-preserves-and-attributes-messages",
    "workflow-select-drops-empty-state-metadata": "workflow-select-validation",
    "deduplicates-only-first-message": "workflow-switch-preserves-and-attributes-messages",
    "deduplicates-only-first-or-last-message": "workflow-switch-preserves-and-attributes-messages",
    "deduplicates-only-edge-and-middle-message": "workflow-switch-preserves-and-attributes-messages",
    "case-insensitive-message-id": "workflow-switch-preserves-and-attributes-messages",
    "duplicate-boolean-override-before-validation": "message-event-validation",
    "late-exotic-text-validation": "message-event-validation",
    "late-exotic-override-validation": "message-event-validation",
    "length-based-string-validator": "workflow-select-validation",
    "direct-event-has-own-property": "workflow-switch-preserves-and-attributes-messages",
    "enumerable-only-workflow-override": "workflow-switch-preserves-and-attributes-messages",
    "mutates-inherited-workflow-prototype": "workflow-switch-preserves-and-attributes-messages",
    "active-workflow-nullish-only": "duplicate-precedes-active-workflow-validation",
    "missing-active-mutates-and-returns": "duplicate-precedes-active-workflow-validation",
    "freezes-valid-events": "workflow-switch-preserves-and-attributes-messages",
    "global-current-workflow-validation": "duplicate-precedes-active-workflow-validation",
    "drops-default-initial-state": "workflow-switch-preserves-and-attributes-messages",
    "defaults-only-workflow-select": "workflow-switch-preserves-and-attributes-messages",
    "workflow-select-validates-prior-current": "workflow-select-validation",
    "mutating-append": "workflow-switch-preserves-and-attributes-messages",
    "mutation-on-invalid": "workflow-select-validation",
    "trim-non-empty": "whitespace-only-values-remain-non-empty"
  };
  for (const [name, source] of Object.entries(mutants)) {
    assert.notEqual(source, reference, `${name} mutant did not change the reference`);
    const workspace = path.join(temporaryRoot, name); const oraclePath = `${workspace}.oracle.json`;
    fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
    generate(workspace, scenario, oraclePath, `workflow-mutant-${name}`);
    fs.writeFileSync(path.join(workspace, relativePath), source.trimStart());
    const result = grade(workspace, scenario, oraclePath);
    assert.equal(result.passed, false, `${name} escaped workflow grader: ${JSON.stringify(result)}`);
    assert.equal(result.checks.find((item) => item.id === expectedFailedCheck[name])?.passed, false,
      `${name} did not fail its intended contract check: ${JSON.stringify(result)}`);
  }
});
