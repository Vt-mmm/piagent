import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadBenchmarkSuite } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";

// Fresh synthetic calibration only. Never reads or executes a paid workspace.
// Alternative implementations exercise the same public contract without relying
// on the single canonical reference's algorithm or local variable spellings.
const root = path.resolve(import.meta.dirname, "..");
const { suite, suiteRoot } = loadBenchmarkSuite("production-v3", root);

async function resumeWork(items, checkpoint, processItem) {
  if (!Array.isArray(items) || typeof processItem !== "function" || !checkpoint
    || typeof checkpoint !== "object" || Array.isArray(checkpoint)) throw new TypeError("bad shape");
  const { nextIndex, results } = checkpoint;
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex > items.length
    || !Array.isArray(results) || results.length !== nextIndex) throw new TypeError("bad bounds");
  const completed = results.slice();
  let cursor = nextIndex;
  while (cursor < items.length) {
    try { completed.push(await processItem(items[cursor], cursor)); }
    catch (failure) { failure.checkpoint = { nextIndex: cursor, results: completed.slice() }; throw failure; }
    cursor += 1;
  }
  return { nextIndex: cursor, results: completed };
}

function parseNdjsonChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.every(chunk => chunk instanceof Uint8Array)) {
    throw new TypeError("byte chunks required");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text.split("\n").map(line => line.endsWith("\r") ? line.slice(0, -1) : line)
    .filter(line => line.length !== 0).map(line => JSON.parse(line));
}

function pageCount(totalItems, pageSize) {
  if (!Number.isInteger(totalItems) || totalItems < 0 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new TypeError("invalid pagination");
  }
  return Math.ceil(totalItems / pageSize);
}
function clampPage(page, totalItems, pageSize) {
  if (!Number.isInteger(page)) throw new TypeError("integer page required");
  const count = pageCount(totalItems, pageSize);
  return count === 0 ? 0 : Math.max(1, Math.min(page, count));
}

function compareSubscriptionContracts(backend, frontend) {
  const declarations = (contract, fieldsKey) => {
    if (!contract || typeof contract !== "object" || Array.isArray(contract)
      || !Number.isInteger(contract.version) || contract.version <= 0) throw new TypeError("invalid contract");
    const sets = [contract.statuses, contract[fieldsKey]].map(values => {
      if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0)) {
        throw new TypeError("invalid declarations");
      }
      const unique = new Set(values);
      if (unique.size !== values.length) throw new TypeError("duplicate declaration");
      return unique;
    });
    return { version: contract.version, statuses: sets[0], fields: sets[1] };
  };
  const expected = declarations(backend, "requiredFields");
  const actual = declarations(frontend, "fields");
  const difference = (left, right) => Array.from(left).filter(value => !right.has(value))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const missingStatuses = difference(expected.statuses, actual.statuses);
  const extraStatuses = difference(actual.statuses, expected.statuses);
  const missingFields = difference(expected.fields, actual.fields);
  const versionMismatch = expected.version !== actual.version;
  return { compatible: !(missingStatuses.length || extraStatuses.length || missingFields.length || versionMismatch),
    missingStatuses, extraStatuses, missingFields, versionMismatch };
}

const exported = (...functions) => functions.map(fn => `export ${fn.toString()}`).join("\n");
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `unambiguous mutation target: ${before}`);
  return source.replace(before, after);
}
const cases = [
  { id: "resumable-checkpoint-partial-failure", check: "checkpoint-validation",
    alternative: exported(resumeWork),
    mutants: [source => replaceOnce(source, 'new TypeError("bad bounds")', 'new RangeError("bad bounds")'),
      source => replaceOnce(source, 'new TypeError("bad shape")', 'new Error("bad shape")')] },
  { id: "chunked-record-boundary", check: "stream-input-and-encoding-validation",
    alternative: exported(parseNdjsonChunks),
    mutants: [source => replaceOnce(source, 'new TypeError("byte chunks required")', 'new Error("byte chunks required")')] },
  { id: "pagination-boundary", check: "invalid-pagination-rejected", alternative: exported(pageCount, clampPage),
    mutants: [source => replaceOnce(source, 'new TypeError("integer page required")', 'new RangeError("integer page required")'),
      source => replaceOnce(source, 'if (!Number.isInteger(page)) throw new TypeError("integer page required");', "")] },
  { id: "backend-frontend-contract-sync", check: "contract-drift-is-complete-and-sorted",
    alternative: exported(compareSubscriptionContracts),
    mutants: [source => replaceOnce(source, 'declarations(backend, "requiredFields")', 'declarations(backend, "fields")'),
      source => replaceOnce(source, ".sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))", ".sort()")] },
  { id: "reconnect-chat-event-order", check: "conflicting-confirmed-message-rejected",
    alternateReference: source => replaceOnce(source, 'new Error("confirmed message conflict")', 'new Error("CONFLICT in confirmed content")'),
    mutants: [source => replaceOnce(source, 'new Error("CONFLICT in confirmed content")', 'new Error("inconsistent message")')] },
  { id: "idempotent-replay-conflict", check: "conflict-is-atomic-and-input-is-validated",
    mutants: [source => replaceOnce(source, "!id(event.eventId)", "false")] }
];

function execute(file, args, environment = {}) {
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, ...environment }
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function graderInput(scenario, oracle) {
  const turns = scenario.userJourney?.turns?.length ?? 1;
  return {
    schemaVersion: 1, contractId: "production-v3-grader-input-v1",
    transport: { status: "completed", processExitCode: 0, threadIdPresent: true, usageReported: true,
      terminalAgentMessage: true, errorEvents: 0, turnFailedEvents: 0, itemErrorEvents: 0, failedCommandEvents: 0 },
    task: { journeyInvariantPassed: true, observedTurnCount: turns, expectedTurnCount: turns,
      operationStatus: "completed", taskStatus: "completed" },
    semantic: { scenarioKind: "source-change", mutationExpected: true, fileChangeCount: 1,
      outsideScopeMutationCount: 0, requiredOutputEvidencePresent: true },
    grade: { oracle }
  };
}

for (const entry of cases) {
  for (const seed of ["contract-calibration-one", "contract-calibration-two"]) {
    test(`visible strict contract calibration: ${entry.id}/${seed}`, t => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-visible-contract-calibration-"));
      t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
      const scenario = suite.scenarios.find(value => value.id === entry.id);
      const workspace = path.join(temporary, "fresh-fixture");
      const oraclePath = path.join(temporary, "oracle.json");
      fs.cpSync(path.join(suiteRoot, scenario.fixture), workspace, { recursive: true });
      execute(path.join(suiteRoot, scenario.variantGenerator), [workspace, oraclePath, seed, entry.id]);
      const oracle = JSON.parse(fs.readFileSync(oraclePath, "utf8"));
      const inputPath = path.join(temporary, "input.json");
      fs.writeFileSync(inputPath, JSON.stringify(graderInput(scenario, oracle)));
      const [target, reference] = productionV3ReferenceSolution(entry.id, oracle);
      const positive = entry.alternative ?? entry.alternateReference?.(reference) ?? reference;
      const grade = source => {
        fs.writeFileSync(path.join(workspace, target), source);
        return JSON.parse(execute(path.join(suiteRoot, scenario.grader), [workspace, inputPath],
          { PIAGENT_BENCHMARK_SCENARIO: entry.id }));
      };
      const valid = grade(positive);
      assert.equal(valid.passed, true, JSON.stringify(valid.checks));
      assert.deepEqual(grade(positive), valid, "positive result is deterministic");
      const mutations = entry.mutants.map(mutate => ({ mutate, check: entry.check }));
      if (entry.id === "pagination-boundary") mutations.push({ check: "ceiling-boundaries",
        mutate: source => replaceOnce(source, "Math.max(1, Math.min(page, count))", "Math.min(page, count)") });
      for (const { mutate, check: expectedFailedCheck } of mutations) {
        const result = grade(mutate(positive));
        assert.equal(result.passed, false);
        assert.deepEqual(result.checks.filter(check => !check.passed).map(check => check.id), [expectedFailedCheck],
          "strict-contract violation must fail exactly its functional check, not a transport or completion surrogate");
      }
      assert.deepEqual(grade(positive), valid, "mutant isolation does not contaminate the valid implementation");
    });
  }
}

test("independent pagination implementation preserves the declared lower clamp", () => {
  assert.equal(clampPage(-4, 10, 5), 1);
  assert.equal(clampPage(0, 10, 5), 1);
  assert.equal(clampPage(-4, 0, 5), 0);
  assert.throws(() => clampPage(1.2, 0, 5), TypeError);
});
