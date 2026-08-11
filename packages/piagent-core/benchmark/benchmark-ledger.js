import crypto from "node:crypto";
import fs from "node:fs";

const algorithm = "sha256-chain-jsonl-v1";
const domain = Buffer.from("piagent-benchmark-ledger-v1\0", "utf8");

function fail(message) {
  const error = new Error(message);
  error.code = "BENCHMARK_LEDGER_INVALID";
  error.exitCode = 1;
  throw error;
}

function nextDigest(previousHex, line) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(line.length));
  return crypto.createHash("sha256")
    .update(Buffer.from(previousHex, "hex"))
    .update(length)
    .update(line)
    .digest("hex");
}

export function emptyBenchmarkLedgerBinding() {
  return {
    schemaVersion: 1,
    algorithm,
    digest: crypto.createHash("sha256").update(domain).digest("hex"),
    records: 0,
    bytes: 0
  };
}

function validBinding(value) {
  return value?.schemaVersion === 1
    && value.algorithm === algorithm
    && /^[a-f0-9]{64}$/.test(String(value.digest ?? ""))
    && Number.isInteger(value.records)
    && value.records >= 0
    && Number.isInteger(value.bytes)
    && value.bytes >= 0;
}

function inspectRawLedger(raw, label) {
  if (raw.length > 0 && raw.at(-1) !== 0x0a) fail(`Benchmark ledger must end with a newline: ${label}`);
  const records = [];
  let binding = emptyBenchmarkLedgerBinding();
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const line = raw.subarray(start, index + 1);
    const json = raw.subarray(start, index).toString("utf8");
    if (!json.trim()) fail(`Benchmark ledger contains an empty record at line ${records.length + 1}: ${label}`);
    let record;
    try { record = JSON.parse(json); }
    catch (error) { fail(`Cannot parse benchmark ledger ${label}:${records.length + 1}: ${error.message}`); }
    records.push(record);
    binding = {
      ...binding,
      digest: nextDigest(binding.digest, line),
      records: binding.records + 1,
      bytes: binding.bytes + line.length
    };
    start = index + 1;
  }
  return { binding, records, raw };
}

export function inspectBenchmarkLedger(file) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ENOENT") return { binding: emptyBenchmarkLedgerBinding(), records: [], raw: Buffer.alloc(0) };
    fail(`Cannot open benchmark ledger without following links: ${file} (${error.message})`);
  }
  try {
    return inspectBenchmarkLedgerDescriptor(descriptor, file);
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectBenchmarkLedgerDescriptor(descriptor, label) {
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isFile()) fail(`${label} is not a regular file`);
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} is too large to inspect safely`);
  const raw = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < raw.length) {
    const read = fs.readSync(descriptor, raw, offset, raw.length - offset, offset);
    if (read === 0) fail(`${label} changed while it was being read`);
    offset += read;
  }
  const after = fs.fstatSync(descriptor, { bigint: true });
  const stable = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((field) => before[field] === after[field]);
  if (!stable) fail(`${label} changed while it was being read`);
  return inspectRawLedger(raw, label);
}

export function assertBenchmarkLedgerBinding(expected, observed, label = "benchmark ledger") {
  if (!validBinding(expected)) fail(`${label} binding is missing or unsupported`);
  if (!validBinding(observed)) fail(`${label} observed binding is invalid`);
  const mismatches = ["algorithm", "digest", "records", "bytes"].filter((field) => expected[field] !== observed[field]);
  if (mismatches.length > 0) fail(`${label} binding mismatch: ${mismatches.join(", ")}`);
  return observed;
}

export function benchmarkLedgerCheckpoint(expected, inspection, label = "benchmark ledger") {
  if (!validBinding(expected)) fail(`${label} checkpoint binding is missing or unsupported`);
  if (!inspection || !Buffer.isBuffer(inspection.raw) || !validBinding(inspection.binding)) fail(`${label} inspection is invalid`);
  if (inspection.binding.records === expected.records && inspection.binding.bytes === expected.bytes) {
    assertBenchmarkLedgerBinding(expected, inspection.binding, label);
    return { ...inspection, recovered: false, checkpointRecords: expected.records };
  }
  if (inspection.binding.records < expected.records || inspection.binding.bytes <= expected.bytes) {
    fail(`${label} is shorter than its committed manifest checkpoint`);
  }
  if (inspection.binding.records !== expected.records + 1) {
    fail(`${label} has more than the single recoverable append beyond its committed manifest checkpoint`);
  }
  const prefix = inspectRawLedger(inspection.raw.subarray(0, expected.bytes), `${label} committed prefix`);
  assertBenchmarkLedgerBinding(expected, prefix.binding, `${label} committed prefix`);
  return { ...inspection, recovered: true, checkpointRecords: expected.records };
}

function runKey(value) {
  return `${value.scenarioId ?? value.scenario?.id}\0${value.surface}\0${value.repeat}`;
}

export function validateBenchmarkLedgerPrefix(records, order, completedRecord) {
  if (!Array.isArray(records) || !Array.isArray(order)) fail("Benchmark ledger validation requires records and execution order");
  if (records.length > order.length) fail(`Benchmark ledger has ${records.length} records for ${order.length} expected sessions`);
  const seen = new Set();
  const sessions = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!completedRecord(record, index, order[index])) fail(`Benchmark ledger record ${index + 1} is not a structurally complete measured session`);
    const key = runKey(record);
    if (seen.has(key)) fail(`Benchmark ledger contains duplicate measured session at record ${index + 1}`);
    seen.add(key);
    if (sessions.has(record.sessionId)) fail(`Benchmark ledger repeats a provider session at record ${index + 1}`);
    sessions.add(record.sessionId);
    const expected = runKey(order[index]);
    if (key !== expected) fail(`Benchmark ledger record ${index + 1} is foreign or out of execution order`);
  }
  return new Set(records.map(runKey));
}

export function appendBenchmarkLedger(file, record, previousBinding) {
  if (!validBinding(previousBinding)) fail("Cannot append benchmark record without a valid prior ledger binding");
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow, 0o600);
  try {
    const current = inspectBenchmarkLedgerDescriptor(descriptor, "benchmark append ledger");
    assertBenchmarkLedgerBinding(previousBinding, current.binding, "benchmark append ledger");
    fs.writeFileSync(descriptor, line);
    fs.fsyncSync(descriptor);
    const expected = {
      ...previousBinding,
      digest: nextDigest(previousBinding.digest, line),
      records: previousBinding.records + 1,
      bytes: previousBinding.bytes + line.length
    };
    assertBenchmarkLedgerBinding(expected, inspectBenchmarkLedgerDescriptor(descriptor, "benchmark appended ledger").binding, "benchmark appended ledger");
    return expected;
  } finally {
    fs.closeSync(descriptor);
  }
}
