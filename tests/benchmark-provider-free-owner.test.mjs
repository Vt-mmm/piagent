import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { writeCheckpoint } from "../packages/piagent-core/benchmark/benchmark-checkpoint.js";

const repository = path.resolve(import.meta.dirname, "..");
const ownerModule = path.join(repository, "packages/piagent-core/benchmark/benchmark-provider-free-owner.js");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for owned lane process");
}
function run(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stdout.resume(); child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, result: new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stderr })); }) };
}

test("a surviving real S0 lane keeps ownership after its benchmark caller dies", { timeout: 30_000 }, async (t) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-s0-owner-")));
  const binding = "a".repeat(64), attempt = randomUUID();
  const checkpoint = path.join(directory, "checkpoint.json");
  writeCheckpoint(checkpoint, binding, { status: "running", attempt });
  const marker = path.join(directory, "executions.txt");
  const entry = path.join(directory, "entry.mjs");
  fs.writeFileSync(entry, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'executed\\n'); setInterval(() => {}, 1000);\n`);
  const env = { ...process.env, PIAGENT_S0_LANE_DIRECTORY: directory, PIAGENT_S0_BINDING: binding, PIAGENT_S0_ATTEMPT: attempt };
  delete env.NODE_TEST_CONTEXT;
  const args = ["--import", ownerModule, entry];
  const controller = pathToFileURL(path.join(repository, "packages/piagent-core/benchmark/benchmark-process.js")).href;
  const outer = run(["--input-type=module", "--eval", `import { createBenchmarkProcessController } from ${JSON.stringify(controller)};
await createBenchmarkProcessController(() => false).run(process.execPath, ${JSON.stringify(args)}, { timeoutMs: 20000 });`], env);
  let lanePid;
  t.after(async () => {
    if (outer.child.exitCode === null && outer.child.signalCode === null) outer.child.kill("SIGKILL");
    await outer.result;
    if (lanePid && alive(lanePid)) { process.kill(lanePid, "SIGTERM"); await until(() => !alive(lanePid)); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await until(() => fs.existsSync(marker));
  const ownership = JSON.parse(fs.readFileSync(path.join(directory, ".benchmark-run.lock"), "utf8"));
  assert.equal(ownership.runId, `s0-lane:${attempt}`);
  lanePid = ownership.pid;
  assert.equal(alive(lanePid), true);
  outer.child.kill("SIGKILL");
  assert.equal((await outer.result).signal, "SIGKILL");
  assert.equal(alive(lanePid), true, "the detached real lane survived its caller");
  const contender = await run(args, env).result;
  assert.equal(contender.code, 75);
  assert.match(contender.stderr, /locked by another process/);
  assert.equal(fs.readFileSync(marker, "utf8"), "executed\n", "no duplicate lane ran");
  process.kill(lanePid, "SIGTERM"); await until(() => !alive(lanePid));
  // An obsolete queued launch must not execute after a replacement reservation.
  writeCheckpoint(checkpoint, binding, { status: "running", attempt: randomUUID() });
  const obsolete = await run(args, env).result;
  assert.equal(obsolete.code, 75);
  assert.match(obsolete.stderr, /reservation changed/);
  assert.equal(fs.readFileSync(marker, "utf8"), "executed\n");
});
