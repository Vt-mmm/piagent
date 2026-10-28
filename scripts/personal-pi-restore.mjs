#!/usr/bin/env node
// Takes Piagent out of the member's personal Pi (~/.pi/agent) and leaves it as
// stock Pi. Releases before 1.45 installed Piagent, its add-ons, a model scope
// and a subagent baseline there, so every plain `pi` loaded them. Piagent now
// runs from its own home (~/.piagent/agent, opened with `piagent`).
//
//   personal-pi-restore.mjs [--apply] [--copy-login] [--json]
//
// Without --apply nothing changes: it reports what it would do. With --apply:
//   - carries the member's model choices, custom models and trust decisions to
//     Piagent's home when that home has none yet (the login only with
//     --copy-login: credentials are copied when the member says so);
//   - removes the Piagent package and the exact-pinned add-ons Piagent
//     installed (pi-mcp-adapter, pi-subagents, pi-web-access) from personal Pi;
//   - removes the subagent baseline and the model list Piagent wrote, when the
//     list still holds only models Piagent offered.
// Every changed file is backed up first. Sessions, the login and anything the
// member added stay in personal Pi.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { personalPiAgentDir, piagentAgentDir } from "../packages/piagent-core/extensions/agent-home.js";

const ADDONS = ["pi-mcp-adapter", "pi-subagents", "pi-web-access"];
const MODEL_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"];
const CARRIED_FILES = ["models.json", "trust.json", "piagent-model-scope.json"];
const isPiagentSource = (source) => /(@piagent\/platform|Vt-mmm\/piagent|pi-company-platform)/.test(source);
// Piagent always installed add-ons at an exact version; an unpinned entry is the member's own.
const isPinnedAddon = (source) => ADDONS.some((name) => source.startsWith(`npm:${name}@`));

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const sourceOf = (entry) => (typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : "");

function isLocalPiagent(agentDir, source) {
  if (/^(npm|git|https?):/.test(source)) return false;
  return readJson(path.join(path.resolve(agentDir, source), "package.json"))?.name === "@piagent/platform";
}

export function plan({ personalDir = personalPiAgentDir(), piagentDir = piagentAgentDir(), copyLogin = false } = {}) {
  const settings = readJson(path.join(personalDir, "settings.json")) ?? {};
  const packages = (Array.isArray(settings.packages) ? settings.packages : []).map(sourceOf).filter(Boolean);
  const remove = packages.filter((source) => isPiagentSource(source) || isLocalPiagent(personalDir, source) || isPinnedAddon(source));
  const kept = packages.filter((source) => !remove.includes(source) && ADDONS.some((name) => source.includes(name)));
  const offered = readJson(path.join(personalDir, "piagent-model-scope.json"))?.offered;
  const models = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
  const piagentModelList = Array.isArray(offered) && models.length > 0 && models.every((model) => offered.includes(model));
  const subagentConfig = path.join(personalDir, "extensions", "subagent", "config.json");
  const target = readJson(path.join(piagentDir, "settings.json")) ?? {};
  const carry = {
    settings: MODEL_KEYS.filter((key) => settings[key] !== undefined && target[key] === undefined),
    files: CARRIED_FILES.filter((name) => fs.existsSync(path.join(personalDir, name)) && !fs.existsSync(path.join(piagentDir, name))),
    login: copyLogin && fs.existsSync(path.join(personalDir, "auth.json")) && !fs.existsSync(path.join(piagentDir, "auth.json"))
  };
  const cleanup = {
    subagentsSetting: settings.subagents !== undefined && remove.some((source) => source.startsWith("npm:pi-subagents@")),
    subagentConfig: fs.existsSync(subagentConfig) && remove.some((source) => source.startsWith("npm:pi-subagents@")),
    enabledModels: piagentModelList,
    modelScopeRecord: fs.existsSync(path.join(personalDir, "piagent-model-scope.json"))
  };
  const loginAvailable = fs.existsSync(path.join(personalDir, "auth.json")) && !fs.existsSync(path.join(piagentDir, "auth.json"));
  const legacy = remove.some((source) => isPiagentSource(source) || isLocalPiagent(personalDir, source));
  return { personalDir, piagentDir, legacy, remove, kept, carry, cleanup, loginAvailable };
}

function backup(file, stamp) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.before-piagent-restore-${stamp}`;
  fs.copyFileSync(file, copy);
  fs.chmodSync(copy, 0o600);
  return copy;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function copyPrivate(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o600);
}

// `pi remove` also deletes the package's files; when Pi is missing or refuses,
// the entry still leaves settings.json so personal Pi stops loading it.
function removePackage(personalDir, source) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: personalDir };
  delete env.PIAGENT_ACTIVE;
  delete env.PIAGENT_AGENT_DIR;
  const result = spawnSync("pi", ["remove", source], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  if (result.status === 0) return "pi remove";
  const file = path.join(personalDir, "settings.json"), settings = readJson(file);
  if (settings && Array.isArray(settings.packages)) {
    settings.packages = settings.packages.filter((entry) => sourceOf(entry) !== source);
    writeJson(file, settings);
  }
  return "settings.json";
}

export function apply(options = {}, now = new Date()) {
  const report = plan(options);
  const { personalDir, piagentDir, carry, cleanup } = report;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backups = [], done = [];
  const personalSettingsFile = path.join(personalDir, "settings.json");
  const anything = report.remove.length || Object.values(cleanup).some(Boolean);
  if (anything) backups.push(backup(personalSettingsFile, stamp));

  // Carry first, so nothing the member chose is lost if a removal fails.
  if (carry.settings.length) {
    const from = readJson(personalSettingsFile) ?? {}, targetFile = path.join(piagentDir, "settings.json");
    const target = readJson(targetFile) ?? {};
    for (const key of carry.settings) target[key] = from[key];
    writeJson(targetFile, target);
    done.push(`carried ${carry.settings.join(", ")} to ${targetFile}`);
  }
  for (const name of carry.files) {
    copyPrivate(path.join(personalDir, name), path.join(piagentDir, name));
    done.push(`carried ${name} to ${piagentDir}`);
  }
  if (carry.login) {
    copyPrivate(path.join(personalDir, "auth.json"), path.join(piagentDir, "auth.json"));
    done.push(`copied the pi login to ${piagentDir} (personal pi keeps its own)`);
  }

  for (const source of report.remove) done.push(`removed ${source} from personal pi (${removePackage(personalDir, source)})`);

  if (cleanup.subagentsSetting || cleanup.enabledModels) {
    const settings = readJson(personalSettingsFile) ?? {};
    if (cleanup.subagentsSetting) { delete settings.subagents; done.push("removed the subagents setting Piagent wrote"); }
    if (cleanup.enabledModels) { delete settings.enabledModels; done.push("removed the model list Piagent wrote"); }
    writeJson(personalSettingsFile, settings);
  }
  if (cleanup.subagentConfig) {
    const file = path.join(personalDir, "extensions", "subagent", "config.json");
    fs.renameSync(file, `${file}.before-piagent-restore-${stamp}`);
    backups.push(`${file}.before-piagent-restore-${stamp}`);
    done.push("set aside the subagent baseline Piagent wrote");
  }
  if (cleanup.modelScopeRecord) {
    fs.rmSync(path.join(personalDir, "piagent-model-scope.json"), { force: true });
    done.push("removed Piagent's model-scope record from personal pi");
  }
  return { ...report, done, backups: backups.filter(Boolean) };
}

function describe(report, applied) {
  const lines = [`Personal pi: ${report.personalDir}`, `Piagent home: ${report.piagentDir}`];
  if (applied) {
    lines.push(...(report.done.length ? report.done.map((line) => `  ${line}`) : ["  nothing to change: personal pi has no Piagent entries"]));
    for (const file of report.backups) lines.push(`  backup: ${file}`);
  } else {
    if (!report.remove.length && !Object.values(report.cleanup).some(Boolean)) lines.push("  nothing to change: personal pi has no Piagent entries");
    for (const source of report.remove) lines.push(`  would remove ${source}`);
    if (report.cleanup.subagentsSetting) lines.push("  would remove the subagents setting Piagent wrote");
    if (report.cleanup.subagentConfig) lines.push("  would set aside extensions/subagent/config.json");
    if (report.cleanup.enabledModels) lines.push("  would remove the model list Piagent wrote");
    if (report.carry.settings.length || report.carry.files.length) lines.push(`  would carry ${[...report.carry.settings, ...report.carry.files].join(", ")} to Piagent's home`);
    if (report.carry.login) lines.push("  would copy the pi login to Piagent's home");
    else if (report.loginAvailable) lines.push("  login stays personal; add --copy-login to use it in Piagent too (else run `piagent`, then /login)");
  }
  for (const source of report.kept) lines.push(`  kept ${source} (not a version Piagent pinned; remove it with pi remove if you do not want it)`);
  if (!applied) lines.push("Dry run. Re-run with --apply to make these changes.");
  return lines.join("\n");
}

const real = (file) => { try { return fs.realpathSync(file); } catch { return null; } };
const invoked = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (invoked) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: piagent restore-pi [--apply] [--copy-login] [--json]\n\nTakes an older Piagent install out of your personal pi (~/.pi/agent) and leaves it stock.\nWithout --apply it only reports. --copy-login also copies your pi login into Piagent's home.");
    process.exit(0);
  }
  const unknown = args.filter((value) => !["--apply", "--copy-login", "--json"].includes(value));
  if (unknown.length) { console.error(`Unknown argument: ${unknown[0]}`); process.exit(2); }
  const options = { copyLogin: args.includes("--copy-login") };
  const applied = args.includes("--apply");
  const report = applied ? apply(options) : plan(options);
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : describe(report, applied));
}
