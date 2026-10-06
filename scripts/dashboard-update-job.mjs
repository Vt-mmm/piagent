#!/usr/bin/env node
// One update started from the dashboard, run apart from it: the dashboard is
// restarted at the end, so this process must outlive it. It moves Pi and
// Piagent to the chosen release with `piagent-update` (Pi first, to the
// version that release pins), restarts the dashboard on the new code, and
// leaves the outcome in ~/.pi/piagent-update-job.json for the new dashboard to
// show. The full output goes to ~/.pi/piagent-update-job.log.
//
//   dashboard-update-job.mjs --from 1.10.0 --to 1.11.0
//     [--updater <script>] [--dashboard <script>] [--home <dir>]   (tests)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const from = option("from"), to = option("to");
const home = path.resolve(option("home", os.homedir()));
const updater = option("updater", path.join(packageRoot, "scripts", "update-global.mjs"));
const dashboard = option("dashboard", path.join(packageRoot, "scripts", "piagent-dashboard.mjs"));
if (!RELEASE.test(from ?? "") || !RELEASE.test(to ?? "")) {
  process.stderr.write("usage: dashboard-update-job.mjs --from X.Y.Z --to X.Y.Z\n");
  process.exit(2);
}

const directory = path.join(home, ".pi"), jobFile = path.join(directory, "piagent-update-job.json");
fs.mkdirSync(directory, { recursive: true });
const startedAt = (() => {
  try { const value = JSON.parse(fs.readFileSync(jobFile, "utf8")); return value?.to === to && Number.isFinite(Date.parse(value.startedAt)) ? value.startedAt : undefined; }
  catch { return undefined; }
})() ?? new Date().toISOString();
function record(fields) {
  const temporary = `${jobFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ from, to, startedAt, pid: process.pid, ...fields }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, jobFile);
}
const finish = (state, fields = {}) => { record({ state, finishedAt: new Date().toISOString(), ...fields }); process.exit(state === "succeeded" ? 0 : 1); };

record({ state: "running" });
const log = fs.openSync(path.join(directory, "piagent-update-job.log"), "w", 0o600);
const env = { ...process.env, PIAGENT_NO_UPDATE_CHECK: "1" };
fs.writeSync(log, `Piagent update ${from} -> ${to} (${new Date().toISOString()})\n`);
const update = spawnSync(process.execPath, [updater, "--version", to], { stdio: ["ignore", log, log], env, timeout: 30 * 60 * 1000 });
if (update.status !== 0) finish("failed", { reason: "update-command-failed" });

let installed;
try { installed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version; } catch { installed = undefined; }
if (installed !== to) finish("failed", { reason: "update-version-mismatch", ...(RELEASE.test(installed ?? "") ? { installed } : {}) });

// Agent Watch pins the company launcher it starts; a release that changed
// the launcher needs the binding imported again in Agent Watch.
let bindingChanged = false;
try {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent");
  const binding = JSON.parse(fs.readFileSync(path.join(agentDir, "agent-watch-managed.json"), "utf8"));
  if (typeof binding?.entrypoint === "string" && typeof binding?.entrypoint_sha256 === "string")
    bindingChanged = crypto.createHash("sha256").update(fs.readFileSync(binding.entrypoint)).digest("hex") !== binding.entrypoint_sha256;
} catch { /* no company binding on this machine */ }

// The new dashboard opens in a new browser tab: the old tab's browser session
// ends with the old dashboard. Its launch link is never written to the log.
fs.writeSync(log, "\nRestarting the dashboard on the new release\n");
// Like the \`piagent\` command, with the package's TypeScript loader: an npm
// install sits under node_modules, where Node does not strip types itself.
// --import takes a URL: a Windows path (C:\...) reads as a URL scheme.
const loader = pathToFileURL(path.join(packageRoot, "scripts", "register-typescript-loader.mjs")).href;
const restart = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", loader, dashboard, "restart", "--json"],
  { stdio: ["ignore", "ignore", log], env, timeout: 3 * 60 * 1000 });
finish("succeeded", { installed, ...(bindingChanged ? { bindingChanged } : {}), ...(restart.status === 0 ? {} : { reason: "dashboard-restart-failed" }) });
