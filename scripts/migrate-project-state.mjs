#!/usr/bin/env node
// Converts a project from the pre-piagent layout to the current one.
//
// This runs once per project. There is no alias layer, so a project that
// still carries the old layout cannot be served by the current guard at all;
// converting is the only path forward. The old files are left in place until
// the caller confirms removal, so an interrupted run is always recoverable.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { migrateTaskState, taskStateMigrationStatus } from "../packages/piagent-core/extensions/task-state.js";

const TASK_CONTRACT_MIGRATION_ID = "task-contract-v2";
const AGENTS_MANAGED_START = "<!-- piagent-managed:start -->";
const AGENTS_MANAGED_END = "<!-- piagent-managed:end -->";
const LEGACY_GENERATED_AGENTS_HASHES = new Set([
  "571fbf7967ce36a0c28fbc703551b6e8ad113933e8de0ba745c69b971eb73fb1"
]);

const RENAMES = [
  { from: ".pi/company-profile.json", to: ".pi/piagent-profile.json" },
  { from: ".pi/company-profile.lock.json", to: ".pi/piagent-profile.lock.json" },
  { from: ".pi/company-state", to: ".pi/piagent-state" }
];

// Applied to the text of migrated JSON and to AGENTS.md, which commonly
// references tool names and profile paths in its instructions.
const TEXT_REPLACEMENTS = [
  ["PI_COMPANY_", "PIAGENT_"],
  ["pi.company/", "piagent/"],
  ["pi-company-", "piagent-"],
  ["company_", "piagent_"],
  ["company-profile", "piagent-profile"],
  ["company-state", "piagent-state"]
];

function usage() {
  console.log(`Usage:
  piagent-migrate [project-path] [--apply] [--remove-old]

Converts project-local state from the pre-piagent layout.

  (default)      Dry run. Reports what would change and exits 0.
  --apply        Write the new layout.
  --remove-old   With --apply, delete the old files once the new ones exist.

After --apply, regenerate the capability lock:
  piagent-capabilities resolve --profile .pi/piagent-profile.json \\
    --output .pi/piagent-profile.lock.json --package-source <source>`);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const apply = args.includes("--apply");
const removeOld = args.includes("--remove-old");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length > 1) {
  console.error(`Expected at most one project path, received ${positional.length}.`);
  usage();
  process.exit(2);
}
if (removeOld && !apply) {
  console.error("--remove-old requires --apply.");
  process.exit(2);
}

const projectPath = path.resolve(positional[0] ?? process.cwd());
if (!fs.existsSync(projectPath)) {
  console.error(`Project path does not exist: ${projectPath}`);
  process.exit(2);
}

function rewriteText(text) {
  let output = text;
  for (const [from, to] of TEXT_REPLACEMENTS) output = output.split(from).join(to);
  return output;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function managedAgentsBlock(text) {
  const start = text.indexOf(AGENTS_MANAGED_START);
  const endStart = text.indexOf(AGENTS_MANAGED_END, start + AGENTS_MANAGED_START.length);
  if (start < 0 || endStart < 0) return undefined;
  return { start, end: endStart + AGENTS_MANAGED_END.length };
}

function currentAgentsTemplate() {
  try {
    return fs.readFileSync(path.resolve(import.meta.dirname, "../templates/project/AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
}

function migrateAgentsText(text) {
  const renamed = rewriteText(text);
  const template = currentAgentsTemplate();
  if (!template) return renamed;
  if (LEGACY_GENERATED_AGENTS_HASHES.has(sha256(renamed))) return template;

  const existingBlock = managedAgentsBlock(renamed);
  const templateBlock = managedAgentsBlock(template);
  if (!existingBlock || !templateBlock) return renamed;
  const replacement = template.slice(templateBlock.start, templateBlock.end);
  return `${renamed.slice(0, existingBlock.start)}${replacement}${renamed.slice(existingBlock.end)}`;
}

function copyRecursive(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) return { skipped: from, reason: "symlink" };
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
    return {};
  }
  if (from.endsWith(".json") || from.endsWith(".md") || from.endsWith(".jsonl")) {
    fs.writeFileSync(to, rewriteText(fs.readFileSync(from, "utf8")));
  } else {
    fs.copyFileSync(from, to);
  }
  return {};
}

const planned = [];
const skipped = [];
// Source and target both present means a previous --apply already copied this
// entry and the caller has not cleaned up yet. That is the normal midpoint of
// the two-step workflow, not a conflict, so it stays eligible for --remove-old.
const alreadyMigrated = [];

for (const { from, to } of RENAMES) {
  const source = path.join(projectPath, from);
  const target = path.join(projectPath, to);
  if (!fs.existsSync(source)) continue;
  if (fs.existsSync(target)) {
    alreadyMigrated.push({ from, to });
    continue;
  }
  planned.push({ from, to });
}

// AGENTS.md is rewritten in place because it is the instruction file the guard
// reads; leaving old tool names there would keep pointing the agent at tools
// that no longer exist.
const agentsPath = path.join(projectPath, "AGENTS.md");
let agentsNeedsRewrite = false;
let migratedAgentsText;
if (fs.existsSync(agentsPath)) {
  const text = fs.readFileSync(agentsPath, "utf8");
  migratedAgentsText = migrateAgentsText(text);
  agentsNeedsRewrite = migratedAgentsText !== text;
}

const taskMigrationBefore = taskStateMigrationStatus(projectPath);
const nothingToDo = planned.length === 0
  && alreadyMigrated.length === 0
  && !agentsNeedsRewrite
  && taskMigrationBefore.legacy === 0
  && taskMigrationBefore.unreadable.length === 0;

if (nothingToDo) {
  console.log(JSON.stringify({ ok: true, projectPath, migrated: false, reason: "already on the current layout" }, null, 2));
  process.exit(0);
}

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    projectPath,
    dryRun: true,
    wouldRename: planned,
    wouldRewrite: agentsNeedsRewrite ? ["AGENTS.md"] : [],
    wouldMigrateTaskContracts: taskMigrationBefore.legacy,
    taskStateWarnings: taskMigrationBefore.unreadable,
    alreadyMigrated,
    next: alreadyMigrated.length > 0 && planned.length === 0
      ? "re-run with --apply --remove-old to delete the originals"
      : "re-run with --apply"
  }, null, 2));
  process.exit(0);
}

if (taskMigrationBefore.unreadable.length > 0) {
  console.log(JSON.stringify({
    ok: false,
    projectPath,
    migrated: false,
    taskStateWarnings: taskMigrationBefore.unreadable,
    reason: "invalid task state requires manual recovery; no project files were changed"
  }, null, 2));
  process.exit(2);
}

const renamed = [];
for (const { from, to } of planned) {
  const result = copyRecursive(path.join(projectPath, from), path.join(projectPath, to));
  if (result.skipped) {
    skipped.push({ path: from, reason: result.reason });
    continue;
  }
  renamed.push({ from, to });
}

if (agentsNeedsRewrite) {
  fs.writeFileSync(agentsPath, migratedAgentsText);
}

const taskMigration = migrateTaskState(projectPath);
if (taskMigration.warnings.length > 0) {
  console.log(JSON.stringify({
    ok: false,
    projectPath,
    migrated: false,
    renamed,
    taskMigration,
    reason: "invalid task state requires manual recovery; old project paths were preserved"
  }, null, 2));
  process.exit(2);
}
if (taskMigration.migrated > 0) {
  const migrationFile = path.join(projectPath, ".pi", "piagent-state", "migrations.json");
  let migrationState = { schemaVersion: 1, applied: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(migrationFile, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.applied)) migrationState = parsed;
  } catch {
    // Missing or unreadable migration metadata is reconstructed from applied work.
  }
  const applied = migrationState.applied.filter((entry) => entry?.id !== TASK_CONTRACT_MIGRATION_ID);
  applied.push({ id: TASK_CONTRACT_MIGRATION_ID, appliedAt: new Date().toISOString(), migrated: taskMigration.migrated });
  fs.mkdirSync(path.dirname(migrationFile), { recursive: true, mode: 0o700 });
  const temporary = `${migrationFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, applied }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, migrationFile);
}

const removed = [];
if (removeOld) {
  for (const { from } of [...renamed, ...alreadyMigrated]) {
    fs.rmSync(path.join(projectPath, from), { recursive: true, force: true });
    removed.push(from);
  }
}

const pendingCleanup = renamed.length + alreadyMigrated.length - removed.length;

console.log(JSON.stringify({
  ok: true,
  projectPath,
  migrated: true,
  renamed,
  alreadyMigrated,
  rewrote: agentsNeedsRewrite ? ["AGENTS.md"] : [],
  taskMigration,
  skipped,
  removedOld: removed,
  next: pendingCleanup > 0
    ? "verify the new files, then re-run with --apply --remove-old to delete the originals"
    : "regenerate the capability lock with piagent-capabilities resolve"
}, null, 2));
