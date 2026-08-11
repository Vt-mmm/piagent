import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendBenchmarkLedger,
  assertBenchmarkLedgerBinding,
  benchmarkLedgerCheckpoint,
  emptyBenchmarkLedgerBinding,
  inspectBenchmarkLedger,
  validateBenchmarkLedgerPrefix
} from "../packages/piagent-core/benchmark/benchmark-ledger.js";

function record(scenarioId, surface, repeat = 1) {
  return { schemaVersion: 1, scenarioId, surface, repeat, sessionId: `${scenarioId}-${surface}-${repeat}`, usage: { sessions: 1, fresh: 1 }, abortSuite: false };
}

function complete(value) {
  return value?.schemaVersion === 1
    && typeof value.scenarioId === "string"
    && ["raw-pi", "piagent", "codex-cli"].includes(value.surface)
    && Number.isInteger(value.repeat)
    && value.abortSuite !== true
    && value.usage?.sessions > 0
    && value.usage?.fresh > 0;
}

function ledgerFile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "runs.jsonl");
}

test("rolling ledger binding preserves the measured prefix byte-for-byte", (t) => {
  const file = ledgerFile(t);
  let binding = emptyBenchmarkLedgerBinding();
  binding = appendBenchmarkLedger(file, record("task", "raw-pi"), binding);
  const prefix = fs.readFileSync(file);
  binding = appendBenchmarkLedger(file, record("task", "piagent"), binding);
  const inspected = inspectBenchmarkLedger(file);
  assert.deepEqual(inspected.binding, binding);
  assert.deepEqual(inspected.raw.subarray(0, prefix.length), prefix);
  assert.deepEqual(assertBenchmarkLedgerBinding(binding, inspected.binding), binding);
  validateBenchmarkLedgerPrefix(inspected.records, [record("task", "raw-pi"), record("task", "piagent")], complete);
});

test("resume ledger validation rejects duplicate, foreign, out-of-order and incomplete records", () => {
  const order = [record("a", "raw-pi"), record("a", "piagent"), record("b", "raw-pi")];
  assert.throws(() => validateBenchmarkLedgerPrefix([record("a", "raw-pi"), record("a", "raw-pi")], order, complete), /duplicate|out of execution order/);
  assert.throws(() => validateBenchmarkLedgerPrefix([record("foreign", "raw-pi")], order, complete), /foreign or out of execution order/);
  assert.throws(() => validateBenchmarkLedgerPrefix([record("a", "piagent")], order, complete), /out of execution order/);
  assert.throws(() => validateBenchmarkLedgerPrefix([{ ...record("a", "raw-pi"), usage: { sessions: 0, fresh: 0 } }], order, complete), /not a structurally complete/);
});

test("ledger parser and binding fail closed on malformed, truncated and tampered bytes", (t) => {
  const file = ledgerFile(t);
  fs.writeFileSync(file, "{malformed}\n", { mode: 0o600 });
  assert.throws(() => inspectBenchmarkLedger(file), /Cannot parse benchmark ledger/);
  fs.writeFileSync(file, JSON.stringify(record("a", "raw-pi")), { mode: 0o600 });
  assert.throws(() => inspectBenchmarkLedger(file), /must end with a newline/);

  let binding = emptyBenchmarkLedgerBinding();
  fs.writeFileSync(file, "", { mode: 0o600 });
  binding = appendBenchmarkLedger(file, record("a", "raw-pi"), binding);
  const bytes = fs.readFileSync(file);
  bytes[bytes.indexOf(Buffer.from("raw-pi"))] = "x".charCodeAt(0);
  fs.writeFileSync(file, bytes);
  assert.throws(() => assertBenchmarkLedgerBinding(binding, inspectBenchmarkLedger(file).binding), /binding mismatch/);
});

test("resume recovers exactly one durable append without rewriting measured bytes", (t) => {
  const file = ledgerFile(t);
  let committed = emptyBenchmarkLedgerBinding();
  committed = appendBenchmarkLedger(file, record("a", "raw-pi"), committed);
  const prefix = fs.readFileSync(file);
  const observed = appendBenchmarkLedger(file, record("a", "piagent"), committed);
  const bytes = fs.readFileSync(file);
  const recovered = benchmarkLedgerCheckpoint(committed, inspectBenchmarkLedger(file));
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.binding, observed);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix);
  appendBenchmarkLedger(file, record("b", "raw-pi"), observed);
  assert.throws(() => benchmarkLedgerCheckpoint(committed, inspectBenchmarkLedger(file)), /single recoverable append/);
});

test("ledger inspection rejects symbolic-link substitution", (t) => {
  const file = ledgerFile(t);
  const target = `${file}.target`;
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, file);
  assert.throws(() => inspectBenchmarkLedger(file), /without following links|symbolic link/i);
});
