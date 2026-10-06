import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    startedAt: new Date().toISOString(), origin: "http://127.0.0.1:9", controlSocket: state.controlSocket, profileRef: "profile_busy",
    packageVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version });

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(path.join(root, "scripts/register-typescript-loader.mjs")).href,
    path.join(root, "scripts/piagent-dashboard.mjs"), "open", "--no-open", "--json", "--agent-dir", agentDir], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { state: "running", launchUrl: "http://127.0.0.1:9/#busy" });
  assert.equal(readGatewayDescriptor(state)?.gatewayInstanceRef, "gateway_busy", "no second Gateway took over");
});

// After an update the Gateway still running is the earlier release and keeps
// serving that release's pages: `open` replaces it instead of reusing it.
test("dashboard open replaces a Gateway left running by an earlier release", { timeout: 60_000 }, async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-older-"));
  const state = gatewayProfileState(agentDir), current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const actions = [];
  const gateway = net.createServer((connection) => {
    connection.setEncoding("utf8");
    connection.once("data", (line) => {
      const action = JSON.parse(line).action; actions.push(action);
      if (action === "stop") { connection.end(`${JSON.stringify({ ok: true })}\n`); sleeper.kill(); gateway.close(); return; }
      connection.end(`${JSON.stringify({ ok: true, value: { launchUrl: "http://127.0.0.1:9/#older-release" } })}\n`);
    });
  });
  await new Promise((resolve) => gateway.listen(state.controlSocket, resolve));
  const stop = () => new Promise((resolve) => spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(path.join(root, "scripts/register-typescript-loader.mjs")).href,
    path.join(root, "scripts/piagent-dashboard.mjs"), "stop", "--json", "--agent-dir", agentDir], { stdio: "ignore" }).on("exit", resolve));
  t.after(async () => { sleeper.kill(); gateway.close(); await stop(); fs.rmSync(agentDir, { recursive: true, force: true }); });
  writeGatewayDescriptor(state, { version: "piagent-gateway-descriptor-v1", gatewayInstanceRef: "gateway_older", pid: sleeper.pid,
    startedAt: new Date().toISOString(), origin: "http://127.0.0.1:9", controlSocket: state.controlSocket, profileRef: "profile_older", packageVersion: "1.0.0" });

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(path.join(root, "scripts/register-typescript-loader.mjs")).href,
    path.join(root, "scripts/piagent-dashboard.mjs"), "open", "--no-open", "--json", "--agent-dir", agentDir], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PIAGENT_NO_UPDATE_CHECK: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.deepEqual(actions.filter((action) => action === "stop"), ["stop"], "the earlier release was asked to stop");
  assert.match(stderr, new RegExp(`Piagent 1\\.0\\.0 is still running; restarting the dashboard on ${current.replaceAll(".", "\\.")}`));
  const opened = JSON.parse(stdout);
  assert.equal(opened.state, "running"); assert.notEqual(opened.launchUrl, "http://127.0.0.1:9/#older-release", "never the earlier release's pages");
  assert.equal(readGatewayDescriptor(state)?.packageVersion, current);
});
