import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";

function runRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("run lock excludes an active owner and releases inode-safely", (t) => {
  const root = runRoot(t);
  const release = acquireBenchmarkRunLock(root, "active");
  assert.throws(() => acquireBenchmarkRunLock(root, "contender"), /locked by another process/);
  release();
  assert.equal(fs.existsSync(path.join(root, ".benchmark-run.lock")), false);
});

test("run lock preserves and replaces a provably dead local owner", (t) => {
  const root = runRoot(t);
  const file = path.join(root, ".benchmark-run.lock");
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, runId: "dead", pid: 2_147_483_647, hostname: os.hostname() })}\n`, { mode: 0o600 });
  const release = acquireBenchmarkRunLock(root, "recovered");
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".benchmark-run.lock.stale-")), true);
  release();
});

test("run lock fails closed on malformed ownership evidence", (t) => {
  const root = runRoot(t);
  const file = path.join(root, ".benchmark-run.lock");
  fs.writeFileSync(file, "not-json\n", { mode: 0o600 });
  assert.throws(() => acquireBenchmarkRunLock(root, "blocked"), /malformed or was replaced/);
  assert.equal(fs.readFileSync(file, "utf8"), "not-json\n");
});

test("stale-lock recovery admits only one concurrent runner", async (t) => {
  const root = runRoot(t);
  const lock = path.join(root, ".benchmark-run.lock");
  const barrier = path.join(root, "start");
  fs.writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1, runId: "dead", pid: 2_147_483_647, hostname: os.hostname() })}\n`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../packages/piagent-core/benchmark/benchmark-run-lock.js")).href;
  const source = `
    import fs from "node:fs";
    import { acquireBenchmarkRunLock } from ${JSON.stringify(moduleUrl)};
    while (!fs.existsSync(process.env.BARRIER)) await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      const release = acquireBenchmarkRunLock(process.env.RUN_ROOT, "contender");
      process.stdout.write("acquired\\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
      release();
    } catch { process.stdout.write("blocked\\n"); }
  `;
  const children = [0, 1].map(() => spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, RUN_ROOT: root, BARRIER: barrier }, stdio: ["ignore", "pipe", "pipe"]
  }));
  const outputs = children.map((child) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    return once(child, "exit").then(() => stdout.trim());
  });
  fs.writeFileSync(barrier, "go\n");
  assert.deepEqual((await Promise.all(outputs)).sort(), ["acquired", "blocked"]);
});

test("a recovery claimant killed mid-recovery does not strand the run", async (t) => {
  if (process.platform === "win32") return;
  const root = runRoot(t);
  const lock = path.join(root, ".benchmark-run.lock");
  const claim = `${lock}.recovery`;
  fs.writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1, runId: "dead", pid: 2_147_483_647, hostname: os.hostname() })}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import os from "node:os";
    fs.writeFileSync(process.env.CLAIM, JSON.stringify({ schemaVersion: 1, pid: process.pid, hostname: os.hostname() }) + "\\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, CLAIM: claim }, stdio: ["ignore", "pipe", "pipe"] });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  const release = acquireBenchmarkRunLock(root, "recovered-after-kill");
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith(".benchmark-run.lock.recovery.stale-")), true);
  release();
});
