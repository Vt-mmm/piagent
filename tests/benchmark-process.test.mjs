import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBenchmarkProcessController } from "../packages/piagent-core/benchmark/benchmark-process.js";

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error?.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} remained alive after process-group cleanup`);
}

test("process runner drains stdio and kills a surviving command process group", async (t) => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-process-group-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leader = path.join(root, "leader.mjs");
  fs.writeFileSync(leader, `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    const ready = ${JSON.stringify(path.join(root, "ready"))};
    const source = 'const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(process.env.READY,"ready"); setTimeout(()=>console.log("late-output"),1000); setInterval(()=>{},1000);';
    const child = spawn(process.execPath, ["-e", source], { env: { ...process.env, READY: ready }, stdio: ["ignore", "inherit", "inherit"] });
    child.unref();
    while (!fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 5));
    console.log("background:" + child.pid);
  `);
  const controller = createBenchmarkProcessController(() => false);
  const result = await controller.run(process.execPath, [leader], { cwd: root, timeoutMs: 5_000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /background:\d+/);
  assert.doesNotMatch(result.stdout, /late-output/);
  const pid = Number(result.stdout.match(/background:(\d+)/)?.[1]);
  await waitForProcessExit(pid);
  assert.match(result.stdoutHash, /^[a-f0-9]{64}$/);
});

test("process runner waits for a detached descendant that closes inherited streams", async (t) => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-process-group-closed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leader = path.join(root, "leader.mjs");
  fs.writeFileSync(leader, `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    const ready = ${JSON.stringify(path.join(root, "ready"))};
    const source = 'const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync(process.env.READY,"ready"); setInterval(()=>{},1000);';
    const child = spawn(process.execPath, ["-e", source], { env: { ...process.env, READY: ready }, stdio: "ignore" });
    child.unref();
    while (!fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 5));
    console.log("background:" + child.pid);
  `);
  const controller = createBenchmarkProcessController(() => false);
  const result = await controller.run(process.execPath, [leader], { cwd: root, timeoutMs: 5_000 });
  const pid = Number(result.stdout.match(/background:(\d+)/)?.[1]);
  assert.equal(result.code, 0);
  await waitForProcessExit(pid);
});
