import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentWatchControlDir, dormantInPersonalPi, personalPiAgentDir, piagentAgentDir } from "../packages/piagent-core/extensions/agent-home.js";
import { apply, plan } from "../scripts/personal-pi-restore.mjs";

// Piagent runs from its own Pi home so the member's `pi` stays stock.
const repo = path.resolve(import.meta.dirname, "..");
const temp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2)); };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("Piagent's home is its own; the personal pi and Agent Watch's folder are not it", () => {
  const home = "/home/member";
  assert.equal(piagentAgentDir({}, home), "/home/member/.piagent/agent");
  assert.equal(piagentAgentDir({ PI_CODING_AGENT_DIR: "/home/member/.pi/agent" }, home), "/home/member/.piagent/agent", "the personal home never becomes Piagent's");
  assert.equal(piagentAgentDir({ PI_CODING_AGENT_DIR: "/tmp/bench" }, home), "/tmp/bench", "a test or benchmark home is honoured");
  assert.equal(piagentAgentDir({ PIAGENT_AGENT_DIR: "/srv/piagent", PI_CODING_AGENT_DIR: "/tmp/bench" }, home), "/srv/piagent");
  assert.equal(personalPiAgentDir(home), "/home/member/.pi/agent");
  assert.equal(agentWatchControlDir(home), "/home/member/.pi/agent");
});

test("the extension sleeps only in the stock pi command running from the personal home", () => {
  const home = temp("piagent-dormant-");
  try {
    const cli = path.join(home, "lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    write(cli, "");
    const studio = path.join(home, "lib/node_modules/@piagent/platform/scripts/piagent-studio.mjs");
    write(studio, "");
    assert.equal(dormantInPersonalPi({}, home, ["node", cli]), true, "plain `pi`");
    assert.equal(dormantInPersonalPi({ PI_CODING_AGENT_DIR: path.join(home, ".pi/agent") }, home, ["node", cli]), true);
    assert.equal(dormantInPersonalPi({ PI_CODING_AGENT_DIR: path.join(home, ".piagent/agent") }, home, ["node", cli]), false, "`piagent`");
    assert.equal(dormantInPersonalPi({ PIAGENT_ACTIVE: "1" }, home, ["node", cli]), false, "explicit opt-in");
    assert.equal(dormantInPersonalPi({}, home, ["node", studio]), false, "hosts that embed Pi decide for themselves");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function legacyHome() {
  const home = temp("piagent-restore-");
  const personal = path.join(home, ".pi/agent"), own = path.join(home, ".piagent/agent");
  write(path.join(personal, "settings.json"), {
    packages: ["git:github.com/Vt-mmm/piagent@abc", "npm:pi-mcp-adapter@2.15.0", "npm:pi-subagents@0.38.0", "npm:pi-web-access@0.17.0", "npm:pi-web-access", "npm:someone-else@1.0.0"],
    subagents: { disableBuiltins: true },
    defaultProvider: "openai-codex", defaultModel: "gpt-6-sol", defaultThinkingLevel: "high",
    enabledModels: ["openai-codex/gpt-6-sol:high", "anthropic/claude-x"],
    theme: "dark"
  });
  write(path.join(personal, "piagent-model-scope.json"), { version: 1, offered: ["openai-codex/gpt-6-sol:high", "anthropic/claude-x"] });
  write(path.join(personal, "extensions/subagent/config.json"), { preset: "safe" });
  write(path.join(personal, "auth.json"), { "openai-codex": { type: "oauth" } });
  write(path.join(personal, "models.json"), { providers: {} });
  return { home, personal, own };
}

test("restore-pi reports before it changes anything, and carries the login only when asked", () => {
  const { home, personal, own } = legacyHome();
  try {
    const before = fs.readFileSync(path.join(personal, "settings.json"), "utf8");
    const report = plan({ personalDir: personal, piagentDir: own });
    assert.equal(report.legacy, true);
    assert.deepEqual(report.remove, ["git:github.com/Vt-mmm/piagent@abc", "npm:pi-mcp-adapter@2.15.0", "npm:pi-subagents@0.38.0", "npm:pi-web-access@0.17.0"]);
    assert.deepEqual(report.kept, ["npm:pi-web-access"], "an unpinned add-on is the member's own");
    assert.equal(report.carry.login, false);
    assert.equal(report.loginAvailable, true);
    assert.equal(fs.readFileSync(path.join(personal, "settings.json"), "utf8"), before);
    assert.equal(fs.existsSync(own), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("restore-pi --apply leaves personal pi stock and Piagent's home with the member's choices", () => {
  const { home, personal, own } = legacyHome();
  try {
    // No `pi` on PATH: the entries still leave settings.json.
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    let result;
    try { result = apply({ personalDir: personal, piagentDir: own, copyLogin: true }); } finally { process.env.PATH = saved; }
    const settings = read(path.join(personal, "settings.json"));
    assert.deepEqual(settings.packages, ["npm:pi-web-access", "npm:someone-else@1.0.0"]);
    assert.equal(settings.subagents, undefined);
    assert.equal(settings.enabledModels, undefined, "the list held only models Piagent offered");
    assert.equal(settings.theme, "dark", "the member's own settings stay");
    assert.equal(settings.defaultModel, "gpt-6-sol", "personal pi keeps a default model");
    assert.equal(fs.existsSync(path.join(personal, "extensions/subagent/config.json")), false);
    assert.equal(fs.existsSync(path.join(personal, "piagent-model-scope.json")), false);
    assert.ok(fs.existsSync(path.join(personal, "auth.json")), "personal pi keeps its login");
    const target = read(path.join(own, "settings.json"));
    assert.equal(target.defaultModel, "gpt-6-sol");
    assert.deepEqual(target.enabledModels, ["openai-codex/gpt-6-sol:high", "anthropic/claude-x"]);
    assert.ok(fs.existsSync(path.join(own, "auth.json")));
    assert.equal(fs.statSync(path.join(own, "auth.json")).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(path.join(own, "piagent-model-scope.json")));
    assert.ok(result.backups.some((file) => file.includes("settings.json.before-piagent-restore-")));
    assert.equal(plan({ personalDir: personal, piagentDir: own }).legacy, false, "a second run has nothing to do");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a model list the member edited stays in personal pi", () => {
  const { home, personal, own } = legacyHome();
  try {
    const file = path.join(personal, "settings.json"), settings = read(file);
    settings.enabledModels.push("my/own-model");
    write(file, settings);
    assert.equal(plan({ personalDir: personal, piagentDir: own }).cleanup.enabledModels, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("`piagent` opens Pi only from Piagent's home and says how to install when it is empty", () => {
  const home = temp("piagent-launch-");
  try {
    const env = { PATH: process.env.PATH, HOME: home };
    // The command dispatches on the name it was invoked as, like the installed bin.
    const bin = path.join(home, "bin"); fs.mkdirSync(bin);
    fs.symlinkSync(path.join(repo, "scripts/piagent-cli.mjs"), path.join(bin, "piagent"));
    const bare = spawnSync(process.execPath, [path.join(bin, "piagent")], { env, encoding: "utf8" });
    assert.equal(bare.status, 1, bare.stderr);
    assert.match(bare.stderr, new RegExp(`Piagent is not installed in ${path.join(home, ".piagent/agent").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(bare.stderr, /piagent restore-pi/);
    const help = spawnSync(process.execPath, [path.join(bin, "piagent"), "help"], { env, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: piagent \[pi options\]/);
    assert.match(help.stdout, /restore-pi/);
    assert.equal(fs.existsSync(path.join(home, ".pi")), false, "asking for help touches no Pi home");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
