import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gatewayProfileState, readGatewayDescriptor, writeGatewayDescriptor } from "../packages/piagent-webui/ownership/profile-state.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `piagent dashboard open` asked the running Gateway for 1.5 s and, without an
// answer, started a second one beside it. A Gateway busy with a large catalog
// answers later than that: the second one took over, and the first ran on
// unreachable, still serving its pages and holding its conversations.
test("dashboard open waits for a running Gateway that answers late instead of starting another", async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-busy-"));
  const state = gatewayProfileState(agentDir);
  const held = new Set();
  const gateway = net.createServer((connection) => {
    held.add(connection);
    connection.setEncoding("utf8");
    connection.once("data", () => setTimeout(() => connection.end(`${JSON.stringify({ ok: true, value: { launchUrl: "http://127.0.0.1:9/#busy" } })}\n`), 2_000));
  });
  await new Promise((resolve) => gateway.listen(state.controlSocket, resolve));
  t.after(async () => {
    for (const connection of held) connection.destroy();
    await new Promise((resolve) => gateway.close(resolve));
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  writeGatewayDescriptor(state, { version: "piagent-gateway-descriptor-v1", gatewayInstanceRef: "gateway_busy", pid: process.pid,
    startedAt: new Date().toISOString(), origin: "http://127.0.0.1:9", controlSocket: state.controlSocket, profileRef: "profile_busy", packageVersion: "test" });

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", path.join(root, "scripts/register-typescript-loader.mjs"),
    path.join(root, "scripts/piagent-dashboard.mjs"), "open", "--no-open", "--json", "--agent-dir", agentDir], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { state: "running", launchUrl: "http://127.0.0.1:9/#busy" });
  assert.equal(readGatewayDescriptor(state)?.gatewayInstanceRef, "gateway_busy", "no second Gateway took over");
});
