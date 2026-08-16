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

test("publishes a complete legacy-compatible lock before it becomes visible", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-atomic-owner-"));
  const target = path.join(root, "events.jsonl");
  const lock = `${target}.lock`;
  const ready = path.join(root, "ready");
  const release = path.join(root, "release");
  const modulePath = new URL("../packages/piagent-core/extensions/state-retention.js", import.meta.url).href;
  const source = [
    'import fs from "node:fs";',
    `const lock = ${JSON.stringify(lock)}; const ready = ${JSON.stringify(ready)}; const release = ${JSON.stringify(release)};`,
    "const original = fs.linkSync.bind(fs);",
    "fs.linkSync = (source, destination) => {",
    "  if (destination === lock) {",
    '    fs.writeFileSync(`${ready}.tmp`, JSON.stringify({ visible: fs.existsSync(lock), body: fs.readFileSync(source, "utf8") }));',
    '    fs.renameSync(`${ready}.tmp`, ready);',
    "    const sleeper = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 10_000;",
    "    while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);",
    "  }",
    "  return original(source, destination);",
    "};",
    `const { appendJsonlBounded } = await import(${JSON.stringify(`${modulePath}?atomic-owner`)});`,
    `appendJsonlBounded(${JSON.stringify(target)}, { event: "atomic" }, { maxBytes: 1024 });`
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const observation = JSON.parse(fs.readFileSync(ready, "utf8"));
  assert.deepEqual(observation, { visible: false, body: `${child.pid}\n` });
  fs.writeFileSync(release, "release\n");
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0, stderr);
  assert.equal(fs.existsSync(lock), false);
});

test("blocks a late legacy writer and recovers a hard-killed main owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-main-crash-"));
  const target = path.join(root, "events.jsonl");
  const lock = `${target}.lock`;
  const ready = path.join(root, "ready");
  const modulePath = new URL("../packages/piagent-core/extensions/state-retention.js", import.meta.url).href;
  const source = [
    'import fs from "node:fs";',
    `const lock = ${JSON.stringify(lock)}; const ready = ${JSON.stringify(ready)};`,
    "const original = fs.linkSync.bind(fs);",
    "fs.linkSync = (source, destination) => { const result = original(source, destination);",
    '  if (destination === lock) { fs.writeFileSync(ready, "ready\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); }',
    "  return result; };",
    `const { appendJsonlBounded } = await import(${JSON.stringify(`${modulePath}?main-crash`)});`,
    `appendJsonlBounded(${JSON.stringify(target)}, { event: "unreachable" }, { maxBytes: 1024 });`
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(ready), true, stderr || "child did not publish its main lock");
  assert.throws(() => fs.openSync(lock, "wx", 0o600), (error) => error?.code === "EEXIST");
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGKILL");
  const result = await exited;
  assert.equal(result.signal, "SIGKILL", stderr);
  appendJsonlBounded(target, { event: "recovered" }, { maxBytes: 1024 });
  assert.deepEqual(readJsonlTail(target, { limit: 1 }), [{ event: "recovered" }]);
  assert.equal(fs.existsSync(lock), false);
});

test("serializes simultaneous recovery of one dead main owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-two-recoverers-"));
  const target = path.join(root, "events.jsonl");
  const start = path.join(root, "start");
  const violation = path.join(root, "overlap");
  fs.writeFileSync(`${target}.lock`, "999999999\n", { mode: 0o600 });
  const modulePath = new URL("../packages/piagent-core/extensions/state-retention.js", import.meta.url).href;
  const children = Array.from({ length: 2 }, (_, index) => {
    const source = [
      'import fs from "node:fs";',
      `const root = ${JSON.stringify(root)}; const target = ${JSON.stringify(target)}; const start = ${JSON.stringify(start)};`,
      "const sleeper = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(start)) Atomics.wait(sleeper, 0, 0, 5);",
      "const original = fs.openSync.bind(fs);",
      "fs.openSync = (file, flags, ...args) => { const descriptor = original(file, flags, ...args);",
      "  if (file === target && typeof flags === 'number' && (flags & fs.constants.O_APPEND)) {",
      `    const inside = pathFor(${index}); fs.writeFileSync(inside, "inside\\n");`,
      '    if (fs.readdirSync(root).filter((name) => name.startsWith("inside-")).length > 1) fs.writeFileSync(`${root}/overlap`, "yes\\n");',
      "    Atomics.wait(sleeper, 0, 0, 75); fs.rmSync(inside, { force: true }); } return descriptor; };",
      `function pathFor(id) { return root + "/inside-" + id; }`,
      `const { appendJsonlBounded } = await import(${JSON.stringify(`${modulePath}?recoverer-${index}`)});`,
      `appendJsonlBounded(target, { recoverer: ${index} }, { maxBytes: 1024 });`
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    return { child, stderr: () => stderr, result: new Promise((resolve) => child.once("exit", (code) => resolve(code))) };
  });
  t.after(() => { for (const entry of children) entry.child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(start, "start\n");
  assert.deepEqual(await Promise.all(children.map((entry) => entry.result)), [0, 0], children.map((entry) => entry.stderr()).join("\n"));
  assert.equal(fs.existsSync(violation), false);
  assert.equal(readJsonlTail(target, { limit: 10 }).length, 2);
});

test("fails closed when a recovery owner is killed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-recovery-crash-"));
  const target = path.join(root, "events.jsonl");
  const recovery = `${target}.lock.recovery`;
  const ready = path.join(root, "ready");
  fs.writeFileSync(`${target}.lock`, "999999999\n", { mode: 0o600 });
  const modulePath = new URL("../packages/piagent-core/extensions/state-retention.js", import.meta.url).href;
  const source = [
    'import fs from "node:fs";',
    `const recovery = ${JSON.stringify(recovery)}; const ready = ${JSON.stringify(ready)};`,
    "const original = fs.linkSync.bind(fs);",
    "fs.linkSync = (source, destination) => { const result = original(source, destination);",
    '  if (destination === recovery) { fs.writeFileSync(ready, "ready\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); }',
    "  return result; };",
    `const { appendJsonlBounded } = await import(${JSON.stringify(`${modulePath}?recovery-crash`)});`,
    `appendJsonlBounded(${JSON.stringify(target)}, { event: "unreachable" }, { maxBytes: 1024 });`
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe" });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(ready), true, "child did not publish its recovery lock");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.throws(() => appendJsonlBounded(target, { event: "blocked" }, { maxBytes: 1024 }), /Timed out waiting for state lock/);
  assert.equal(fs.readFileSync(recovery, "utf8"), `${child.pid}\n`);
  assert.equal(fs.existsSync(target), false);
});

test("ignores orphan candidates and leaves a replacement lock intact on release", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-owner-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  const lock = `${target}.lock`;
  fs.writeFileSync(`${lock}.999999999.orphan.candidate`, "orphan\n", { mode: 0o600 });
  const original = fs.openSync.bind(fs);
  let replaced = false;
  fs.openSync = (file, flags, ...args) => {
    const descriptor = original(file, flags, ...args);
    if (!replaced && file === target && typeof flags === "number" && (flags & fs.constants.O_APPEND)) {
      replaced = true;
      fs.renameSync(lock, `${lock}.former`);
      fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    }
    return descriptor;
  };
  try {
    appendJsonlBounded(target, { event: "written" }, { maxBytes: 1024 });
  } finally {
    fs.openSync = original;
  }
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`);
  assert.deepEqual(readJsonlTail(target, { limit: 1 }), [{ event: "written" }]);
});

test("blocks behind a live legacy main lock and succeeds after operator release", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-legacy-first-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  const lock = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  assert.throws(
    () => appendJsonlBounded(target, { event: "blocked" }, { maxBytes: 1024 }),
    /Timed out waiting for state lock/
  );
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(lock);
  appendJsonlBounded(target, { event: "released" }, { maxBytes: 1024 });
  assert.deepEqual(readJsonlTail(target, { limit: 1 }), [{ event: "released" }]);
});

test("recovers a stale malformed all-digit legacy owner", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-malformed-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  const lock = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(lock, "9".repeat(400), { mode: 0o600 });
  const stale = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, stale, stale);
  appendJsonlBounded(target, { event: "recovered" }, { maxBytes: 1024 });
  assert.deepEqual(readJsonlTail(target, { limit: 1 }), [{ event: "recovered" }]);
  assert.equal(fs.existsSync(lock), false);
});

test("fails closed on non-regular main and recovery locks", (t) => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retention-nonregular-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "events.jsonl");
  const lock = `${target}.lock`;
  fs.symlinkSync(root, lock);
  assert.throws(() => appendJsonlBounded(target, { event: "blocked-main" }, { maxBytes: 1024 }), /Timed out waiting for state lock/);
  fs.unlinkSync(lock);
  fs.mkdirSync(lock);
  assert.throws(() => appendJsonlBounded(target, { event: "blocked-main-directory" }, { maxBytes: 1024 }), /Timed out waiting for state lock/);
  fs.rmdirSync(lock);
  fs.writeFileSync(lock, "999999999\n", { mode: 0o600 });
  fs.symlinkSync(root, `${lock}.recovery`);
  assert.throws(() => appendJsonlBounded(target, { event: "blocked-recovery-symlink" }, { maxBytes: 1024 }), /Timed out waiting for state lock/);
  fs.unlinkSync(`${lock}.recovery`);
  fs.mkdirSync(`${lock}.recovery`);
  assert.throws(() => appendJsonlBounded(target, { event: "blocked-recovery-directory" }, { maxBytes: 1024 }), /Timed out waiting for state lock/);
  assert.equal(fs.existsSync(target), false);
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
