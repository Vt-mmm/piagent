#!/usr/bin/env node
// What in the member's personal Pi configuration (~/.pi/agent) conflicts with
// Piagent, and the repair. Personal Pi loads Piagent as a Pi package; an
// extension path that points into another Piagent copy registers the same
// tools twice and Pi refuses to start ("Tool … conflicts with …"). Older Agent
// Watch releases also wrote company providers (agent_watch_*, a direct key
// read from Agent Watch) and a company default model into personal Pi; with a
// managed binding (agent-watch-managed.json) the company runs only through
// `piagent studio`, so those entries are leftovers that send personal Pi to
// Studio outside the team's Harness, or fail.
//
//   personal-pi-config.mjs check [--agent-dir <dir>] [--json]   exit 1 when something conflicts
//   personal-pi-config.mjs repair [--agent-dir <dir>]           backs up, then removes what conflicts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPANY_PROVIDER = /^agent_watch_/;
const SESSION_HEADER_EXTENSION = "agentwatch-studio-session.mjs";

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const real = (file) => { try { return fs.realpathSync(file); } catch { return null; } };

// The Piagent package a path belongs to (its root), or null.
export function piagentRootOf(file) {
  let dir = real(file);
  if (!dir) return null;
  if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  for (; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = readJson(path.join(dir, "package.json"));
    if (manifest?.name === "@piagent/platform") return dir;
  }
  return null;
}

const isPiagentSource = (source) => /^(git:github\.com\/Vt-mmm\/piagent|https:\/\/github\.com\/Vt-mmm\/piagent|npm:@piagent\/platform)(@|$)/.test(String(source));

// The installed Pi package's version (git:… sources live under <agentDir>/git/…).
export function packageVersion(agentDir, source) {
  const match = /^git:([^@]+)/.exec(String(source));
  if (match) return readJson(path.join(agentDir, "git", match[1], "package.json"))?.version ?? null;
  const npm = /^npm:(@piagent\/platform)/.exec(String(source));
  if (npm) return readJson(path.join(agentDir, "npm", "node_modules", npm[1], "package.json"))?.version ?? null;
  return null;
}

export function inspect(agentDir) {
  const settingsFile = path.join(agentDir, "settings.json"), modelsFile = path.join(agentDir, "models.json");
  const settings = readJson(settingsFile) ?? {}, models = readJson(modelsFile) ?? {};
  const managed = fs.existsSync(path.join(agentDir, "agent-watch-managed.json"));
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const piagentPackages = packages.filter(isPiagentSource);
  const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
  const findings = [];

  // Extensions inside a Piagent copy load beside the Pi package: duplicate tools.
  const duplicate = extensions.filter((entry) => piagentRootOf(path.resolve(agentDir, String(entry))) && piagentPackages.length);
  if (duplicate.length) findings.push({ kind: "duplicate-extensions", file: settingsFile, entries: duplicate,
    text: `${duplicate.length} extension(s) point into another Piagent copy while the Piagent Pi package is installed: Pi refuses to start (tools registered twice).` });
  if (piagentPackages.length > 1) findings.push({ kind: "duplicate-packages", file: settingsFile, entries: piagentPackages,
    text: `${piagentPackages.length} Piagent Pi packages are registered; keep one.` });

  if (managed) {
    const providers = Object.keys(models.providers ?? {}).filter((name) => COMPANY_PROVIDER.test(name));
    if (providers.length) findings.push({ kind: "company-providers", file: modelsFile, entries: providers,
      text: `Old Agent Watch company providers (${providers.join(", ")}) are in personal Pi; company work runs only through \`piagent studio\`.` });
    const defaults = [];
    if (COMPANY_PROVIDER.test(String(settings.defaultProvider ?? ""))) defaults.push(`defaultProvider=${settings.defaultProvider}`);
    for (const entry of Array.isArray(settings.enabledModels) ? settings.enabledModels : []) if (COMPANY_PROVIDER.test(String(entry))) defaults.push(`enabledModels:${entry}`);
    if (defaults.length) findings.push({ kind: "company-defaults", file: settingsFile, entries: defaults,
      text: "Personal Pi's default model or model list still names an old company provider." });
    const header = extensions.filter((entry) => path.basename(String(entry)) === SESSION_HEADER_EXTENSION);
    if (header.length) findings.push({ kind: "company-extension", file: settingsFile, entries: header,
      text: "The old Agent Watch session-header extension is still loaded in personal Pi." });
  }
  return { agentDir, managed, findings, packages: piagentPackages.map((source) => ({ source, version: packageVersion(agentDir, source) })) };
}

function backup(file, stamp) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.before-piagent-repair-${stamp}`;
  fs.copyFileSync(file, copy);
  fs.chmodSync(copy, 0o600);
  return copy;
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Removes what inspect() found (duplicate packages are left to the installer,
// which knows the one to keep). Every changed file is backed up first.
export function repair(agentDir, now = new Date()) {
  const report = inspect(agentDir);
  const kinds = new Set(report.findings.map((finding) => finding.kind));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const changed = [], backups = [];
  const settingsFile = path.join(agentDir, "settings.json"), modelsFile = path.join(agentDir, "models.json");
  if (kinds.has("duplicate-extensions") || kinds.has("company-defaults") || kinds.has("company-extension")) {
    const settings = readJson(settingsFile);
    const drop = new Set(report.findings.filter((f) => f.kind === "duplicate-extensions" || f.kind === "company-extension").flatMap((f) => f.entries));
    if (Array.isArray(settings.extensions)) settings.extensions = settings.extensions.filter((entry) => !drop.has(entry));
    if (Array.isArray(settings.extensions) && !settings.extensions.length) delete settings.extensions;
    if (COMPANY_PROVIDER.test(String(settings.defaultProvider ?? ""))) { delete settings.defaultProvider; delete settings.defaultModel; }
    if (Array.isArray(settings.enabledModels)) settings.enabledModels = settings.enabledModels.filter((entry) => !COMPANY_PROVIDER.test(String(entry)));
    backups.push(backup(settingsFile, stamp)); writeJson(settingsFile, settings); changed.push(settingsFile);
  }
  if (kinds.has("company-providers")) {
    const models = readJson(modelsFile);
    for (const name of Object.keys(models.providers ?? {})) if (COMPANY_PROVIDER.test(name)) delete models.providers[name];
    backups.push(backup(modelsFile, stamp)); writeJson(modelsFile, models); changed.push(modelsFile);
  }
  return { ...report, changed, backups: backups.filter(Boolean), after: inspect(agentDir) };
}

const invoked = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (invoked) {
  const args = process.argv.slice(2), command = args[0];
  const at = args.indexOf("--agent-dir");
  const agentDir = at >= 0 ? path.resolve(args[at + 1]) : (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  if (!["check", "repair"].includes(command)) { console.error("Usage: personal-pi-config.mjs check|repair [--agent-dir <dir>] [--json]"); process.exit(2); }
  const result = command === "repair" ? repair(agentDir) : inspect(agentDir);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else if (command === "repair") {
    for (const finding of result.findings) console.log(`fixed: ${finding.text}`);
    for (const file of result.backups) console.log(`backup: ${file}`);
    if (!result.findings.length) console.log("personal Pi configuration: nothing to repair");
  } else {
    for (const finding of result.findings) console.log(`WARN: ${finding.text}`);
    if (result.findings.length) console.log("Fix: piagent-update (or node scripts/personal-pi-config.mjs repair)");
    else console.log("PASS: personal Pi configuration has no Piagent conflicts");
  }
  process.exit(command === "check" && result.findings.length ? 1 : 0);
}
