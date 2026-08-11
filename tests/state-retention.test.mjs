import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendJsonlBounded,
  pruneCaptureFiles,
  readJsonlTail
} from "../packages/piagent-core/extensions/state-retention.js";

test("rotates bounded JSONL while retaining a readable previous generation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "state", "events.jsonl");
  for (let index = 0; index < 12; index += 1) {
    appendJsonlBounded(target, { index, value: "x".repeat(24) }, { maxBytes: 180 });
  }
  assert.equal(fs.existsSync(`${target}.1`), true);
  assert.ok(fs.statSync(target).size <= 180);
  const records = readJsonlTail(target, { limit: 20, maxBytes: 1024 });
  assert.equal(records.at(-1).index, 11);
  assert.ok(records.length >= 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("replaces one oversized record with a bounded audit marker", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-large-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  const written = appendJsonlBounded(target, {
    schemaVersion: 1,
    recordedAt: "2026-07-31T12:00:00.000Z",
    event: "large_trace",
    value: "x".repeat(10_000)
  }, { maxBytes: 256 });
  assert.equal(written.truncated, true);
  assert.equal(written.event, "large_trace");
  assert.ok(fs.statSync(target).size <= 256);
  assert.deepEqual(readJsonlTail(target, { limit: 1, maxBytes: 1024 }), [written]);
});

test("serializes concurrent writers without partial JSON or abandoned locks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-concurrent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  const modulePath = new URL("../packages/piagent-core/extensions/state-retention.js", import.meta.url).href;
  const source = [
    `import { appendJsonlBounded } from ${JSON.stringify(modulePath)};`,
    `const target = ${JSON.stringify(target)};`,
    "for (let index = 0; index < 30; index += 1) appendJsonlBounded(target, { writer: process.argv[1], index }, { maxBytes: 8192 });"
  ].join("\n");
  const children = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, String(index)], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  }));
  await Promise.all(children);
  const records = readJsonlTail(target, { limit: 200, maxBytes: 16 * 1024 });
  assert.equal(records.length, 120);
  assert.equal(new Set(records.map((record) => `${record.writer}:${record.index}`)).size, 120);
  assert.equal(fs.existsSync(`${target}.lock`), false);
  assert.ok(fs.statSync(target).size <= 8192);
});

test("recovers a state lock left by a dead local writer without waiting for the stale timeout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-dead-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  fs.writeFileSync(`${target}.lock`, "999999999\n", { mode: 0o600 });
  const startedAt = Date.now();
  appendJsonlBounded(target, { event: "recovered" }, { maxBytes: 1024 });
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(fs.existsSync(`${target}.lock`), false);
  assert.deepEqual(readJsonlTail(target, { limit: 1 }), [{ event: "recovered" }]);
});

test("prunes captures by age, count, and aggregate bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-captures-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  for (let index = 0; index < 5; index += 1) {
    const target = path.join(root, "2026-07-31", `${index}.log`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x".repeat(600_000));
    const time = new Date(now - index * 60_000);
    fs.utimesSync(target, time, time);
  }
  const old = path.join(root, "2026-01-01", "old.log");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, "old");
  const oldTime = new Date(now - 60 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, oldTime, oldTime);

  const result = pruneCaptureFiles(root, {
    maxFiles: 3,
    maxBytes: 1024 * 1024,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    nowMs: now
  });
  assert.equal(result.kept, 1);
  assert.equal(result.bytes, 600_000);
  assert.equal(result.removed, 5);
  assert.equal(fs.existsSync(old), false);
});
