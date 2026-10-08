// A new Piagent release, said in the Terminal the way the dashboard says it:
// a question with "Update now" and "Later", asked when the Terminal is idle,
// and a footer line until the machine is updated. "Later" asks again after an
// hour, per release. The registry is asked in the background every hour
// (update-check.js keeps the cache); nothing here waits on the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { compareReleaseVersions, evaluateUpdateCheck, readUpdateCache, releaseVersion } from "../../extensions/update-check.js";

const PROBE_MODULE = fileURLToPath(new URL("../../extensions/update-check.js", import.meta.url));

export const SNOOZE_MS = 60 * 60 * 1000;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const SNOOZE_FILE = "piagent-update-snooze.json", LOG_FILE = "piagent-update-terminal.log";
const STATUS_KEY = "piagent-update";
// The dashboard's own runtime UI: the dashboard asks with its dialog instead.
const GATEWAY_UI = Symbol.for("piagent.webui.gateway-runtime-ui.v1");
const UPDATE_NOW = "Cập nhật ngay", LATER = "Để sau (nhắc lại sau 1 giờ)";

const stateFile = (home, name) => path.join(home ?? os.homedir(), ".pi", name);

export function readSnooze(home) {
  try { const value = JSON.parse(fs.readFileSync(stateFile(home, SNOOZE_FILE), "utf8"));
    return { version: releaseVersion(value?.version), until: Number.isFinite(value?.until) ? value.until : 0 }; }
  catch { return { version: undefined, until: 0 }; }
}
export function snoozeUpdate(version, { home, now = Date.now() } = {}) {
  const file = stateFile(home, SNOOZE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version, until: now + SNOOZE_MS })}\n`, { mode: 0o600 });
}

// The release to offer now: newer than the installed one and not put off.
export function pendingUpdate({ installed, home, now = Date.now() }) {
  const latest = releaseVersion(readUpdateCache(home).latest), current = releaseVersion(installed);
  if (!latest || !current || compareReleaseVersions(latest, current) <= 0) return null;
  const snooze = readSnooze(home);
  return snooze.version === latest && now < snooze.until ? null : latest;
}

// The company Terminal runs with a bare PATH: npm sits next to this Node.
const npmPath = () => [path.dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter);

// Asks the registry (`npm view`) and refreshes the cache; `wait` for an answer
// the member asked for, otherwise detached so nothing waits on the network.
export function probeRegistry({ wait = false, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(process.execPath, [PROBE_MODULE, "--probe"], { detached: !wait, stdio: "ignore", windowsHide: true, env: { ...process.env, PATH: npmPath() } }); }
    catch { resolve(false); return; }
    if (!wait) { child.unref?.(); resolve(true); return; }
    const timer = setTimeout(() => { child.kill?.(); resolve(false); }, 20_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

// `piagent-update --version X`, as the dashboard's update runs it.
export function runPiagentUpdate({ packageRoot, version, home, spawnImpl = spawn }) {
  const log = stateFile(home, LOG_FILE);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, "w", 0o600);
  const PATH = npmPath();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [path.join(packageRoot, "scripts", "update-global.mjs"), "--version", version],
        { stdio: ["ignore", out, out], env: { ...process.env, PATH, PIAGENT_NO_UPDATE_CHECK: "1" }, windowsHide: true });
    } catch { fs.closeSync(out); resolve({ ok: false, log }); return; }
    child.once("error", () => { fs.closeSync(out); resolve({ ok: false, log }); });
    child.once("exit", (code) => { fs.closeSync(out); resolve({ ok: code === 0, log }); });
  });
}

// `restart`: what the member runs to use the new release (`pi`, `piagent studio`).
export function registerTerminalUpdateOffer(pi, { installed, packageRoot, restart, home, afterUpdate = () => null, runUpdate = runPiagentUpdate, probe: askRegistry = probeRegistry }) {
  if (!releaseVersion(installed) || process.env.PIAGENT_NO_UPDATE_CHECK?.trim()) return;
  let asking = false, ui = null, updated = null;
  const probe = () => { if (evaluateUpdateCheck({ installed, cache: readUpdateCache(home), now: Date.now() }).probe) void askRegistry(); };
  const status = (version) => ui?.setStatus?.(STATUS_KEY, version ? `⬆ Piagent ${version} · /piagent-update` : undefined);
  const update = async (ctx, version) => {
    ctx.ui.notify(`Đang cập nhật Piagent ${installed} → ${version}…`, "info");
    const result = await runUpdate({ packageRoot, version, home });
    if (!result.ok) { ctx.ui.notify(`Chưa cập nhật được Piagent. Chi tiết trong ${result.log}. Có thể chạy \`piagent-update\` trong terminal.`, "error"); return; }
    updated = version; status(undefined);
    const extra = afterUpdate();
    ctx.ui.notify(`Đã cập nhật Piagent ${installed} → ${version}. Thoát rồi mở lại \`${restart}\` để dùng bản mới.${extra ? ` ${extra}` : ""}`, "info");
  };
  const offer = async (ctx, { force = false } = {}) => {
    if (asking || updated || !ctx?.hasUI || ctx.ui?.[GATEWAY_UI] || !ctx.ui?.select) return;
    ui = ctx.ui;
    const version = force ? releaseVersion(readUpdateCache(home).latest) : pendingUpdate({ installed, home });
    const newer = version && compareReleaseVersions(version, installed) > 0;
    status(newer ? version : undefined);
    if (!newer) { if (force) ctx.ui.notify(`Piagent ${installed} là bản mới nhất.`, "info"); return; }
    asking = true;
    try {
      const choice = await ctx.ui.select(`Có bản Piagent mới: ${version} (đang dùng ${installed})`, [UPDATE_NOW, LATER]);
      if (choice === UPDATE_NOW) await update(ctx, version);
      else snoozeUpdate(version, { home });
    } finally { asking = false; }
  };
  pi.on("session_start", async (_event, ctx) => { probe(); await offer(ctx); });
  // Only between turns: a question never interrupts the agent.
  pi.on("agent_end", async (_event, ctx) => { probe(); await offer(ctx); });
  const timer = setInterval(probe, CHECK_EVERY_MS); timer.unref?.();
  pi.on("session_shutdown", () => clearInterval(timer));
  pi.registerCommand("piagent-update", { description: "Kiểm tra và cập nhật Piagent lên bản mới nhất",
    handler: async (_args, ctx) => { ctx.ui.notify("Đang kiểm tra bản Piagent mới…", "info"); await askRegistry({ wait: true }); await offer(ctx, { force: true }); } });
}
