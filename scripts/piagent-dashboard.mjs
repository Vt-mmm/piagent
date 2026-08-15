#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requestGatewayControl } from "../packages/piagent-webui/gateway/control-socket.ts";
import { installedPiHostRoot } from "../packages/piagent-webui/gateway/pi-host.ts";
import { gatewayProfileState, profileRef, readGatewayDescriptor, readOrCreateCatalogKey,
  removeGatewayDescriptor } from "../packages/piagent-webui/gateway/profile-state.ts";
import { startPiagentGateway } from "../packages/piagent-webui/gateway/gateway-service.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const expectedPiVersion = packageJson.peerDependencies["@earendil-works/pi-coding-agent"];
const args = process.argv.slice(2);
const command = ["--help", "-h"].includes(args[0]) ? args.shift()
  : args[0] && !args[0].startsWith("-") ? args.shift() : "open";
const noOpen = args.includes("--no-open");
const json = args.includes("--json");
const repair = args.includes("--repair");
const agentDirIndex = args.indexOf("--agent-dir");
const agentDir = agentDirIndex >= 0 ? args[agentDirIndex + 1] : undefined;

function output(value) {
  process.stdout.write(`${json ? JSON.stringify(value) : value}\n`);
}

function openBrowser(url) {
  if (noOpen) return;
  const opener = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const result = spawnSync(opener[0], opener[1], { stdio: "ignore" });
  if (result.status !== 0) process.stderr.write(`Dashboard is ready at ${url}\n`);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

function ownerOnlyDirectory(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
      && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch { return false; }
}

function removeOwnedRegularFile(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    fs.unlinkSync(target); return true;
  } catch { return false; }
}

function removeOwnedSocket(target) {
  if (process.platform === "win32") return false;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSocket() || stat.isSymbolicLink()
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
    fs.unlinkSync(target); return true;
  } catch { return false; }
}

async function control(action, timeoutMs = 1_500) {
  const state = gatewayProfileState(agentDir);
  return await requestGatewayControl(state.controlSocket, { action }, timeoutMs);
}

async function currentLaunchUrl() {
  try {
    const response = await control("issue-launch-url");
    if (response.ok && response.value && typeof response.value === "object"
      && typeof response.value.launchUrl === "string") return response.value.launchUrl;
  } catch {
    // Gateway is not ready yet.
  }
  return null;
}

async function ensureStarted() {
  const existing = await currentLaunchUrl();
  if (existing) return existing;
  const effectiveAgentDir = path.resolve(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--import", path.join(packageRoot, "scripts", "register-typescript-loader.mjs"),
    fileURLToPath(import.meta.url),
    "serve",
    ...(agentDir ? ["--agent-dir", agentDir] : [])
  ], { cwd: process.cwd(), env: { ...process.env,
    PIAGENT_PINNED_TS_TRANSFORM_ROOT: path.join(effectiveAgentDir, "npm", "node_modules", "pi-mcp-adapter") },
    detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const url = await currentLaunchUrl();
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("gateway-start-timeout");
}

async function serve() {
  const gateway = await startPiagentGateway({ packageRoot, expectedPiVersion, agentDir });
  const shutdown = () => { void gateway.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await gateway.wait();
}

async function main() {
  if (command === "serve") return await serve();
  if (["help", "--help", "-h"].includes(command)) {
    output("Usage: piagent dashboard [open|status|stop|restart|doctor] [--no-open] [--json] [--repair]");
    return;
  }
  if (command === "open" || command === "start") {
    const launchUrl = await ensureStarted();
    output(json ? { state: "running", launchUrl } : launchUrl);
    openBrowser(launchUrl);
    return;
  }
  if (command === "status") {
    try {
      const response = await control("health");
      if (!response.ok) throw new Error(response.error);
      output(json ? { state: "running", gateway: response.value } : "Piagent Gateway is running.");
    } catch {
      const descriptor = readGatewayDescriptor(gatewayProfileState(agentDir));
      output(json ? { state: "stopped", staleDescriptor: Boolean(descriptor) } : "Piagent Gateway is stopped.");
      process.exitCode = 1;
    }
    return;
  }
  if (command === "stop") {
    try {
      const response = await control("stop");
      if (!response.ok) throw new Error(response.error);
      output(json ? { state: "stopping" } : "Piagent Gateway is stopping.");
    } catch {
      output(json ? { state: "stopped" } : "Piagent Gateway is already stopped.");
    }
    return;
  }
  if (command === "restart") {
    try { await control("stop"); } catch { /* already stopped */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const launchUrl = await ensureStarted();
    output(json ? { state: "running", launchUrl } : launchUrl);
    openBrowser(launchUrl);
    return;
  }
  if (command === "doctor") {
    const state = gatewayProfileState(agentDir);
    const key = readOrCreateCatalogKey(state), descriptor = readGatewayDescriptor(state);
    let actual = null;
    try {
      const hostRoot = installedPiHostRoot();
      actual = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8")).version;
    } catch { /* reported as a failed check below */ }
    let health = null;
    try {
      const response = await control("health", 1_000);
      health = response.ok ? "ready" : "unavailable";
    } catch { health = "unavailable"; }
    const staleDescriptor = Boolean(descriptor && !processAlive(descriptor.pid));
    const invalidDescriptor = fs.existsSync(state.descriptorFile) && !descriptor;
    const repairs = [];
    if (repair && staleDescriptor && descriptor) {
      removeGatewayDescriptor(state, descriptor.gatewayInstanceRef); repairs.push("stale-descriptor-removed");
    } else if (repair && invalidDescriptor && removeOwnedRegularFile(state.descriptorFile)) repairs.push("invalid-descriptor-removed");
    if (repair && health !== "ready" && removeOwnedSocket(state.controlSocket)) repairs.push("stale-control-socket-removed");
    const checks = {
      piHostVersion: actual === expectedPiVersion,
      clientBuild: fs.existsSync(path.join(packageRoot, "packages", "piagent-webui", "dist", "client", "index.html")),
      profileStateOwnerOnly: ownerOnlyDirectory(state.root),
      descriptor: !invalidDescriptor && !staleDescriptor,
      gatewayHealth: descriptor ? health === "ready" : true
    };
    const result = {
      ok: Object.values(checks).every(Boolean),
      expectedPiVersion,
      actualPiVersion: actual,
      profileRef: profileRef(state, key),
      gateway: descriptor ? health === "ready" ? "ready" : staleDescriptor ? "stale" : "unavailable" : "not-registered",
      checks,
      repaired: repairs
    };
    output(json ? result : result.ok ? "Piagent Gateway doctor passed." : repair && repairs.length
      ? "Piagent Gateway doctor repaired stale local state; run doctor again."
      : "Piagent Gateway doctor found a version, build, ownership, or lifecycle mismatch.");
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown-dashboard-command:${command}`);
}

main().catch((error) => {
  process.stderr.write(`Piagent dashboard failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
