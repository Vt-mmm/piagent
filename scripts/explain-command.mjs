#!/usr/bin/env node
// Answers the one question the guard never answers: why.
//
// A blocked command is the only interface most operators ever have with this
// policy, and a denial that says "no" without saying "what now" leaves them
// guessing. This runs the guard's static shell preflight, in the same order,
// over the same resolved protected paths, and prints what each step saw.
//
// It reuses `shell-reach.js` rather than re-deriving anything. A second opinion
// about what a command reaches would be worse than no opinion: the operator
// would tune a command until this said allow and still be blocked at run time.
// The final decision also depends on live session/task facts this standalone
// process does not own, so passing static preflight is deliberately reported as
// indeterminate rather than as permission to execute.

import path from "node:path";

import { evaluateExecPolicyCore, findProtectedPathInCommand, unresolvedPathExpansions } from "../packages/piagent-core/extensions/policy-core.js";
import {
  findResolvedProtectedPathInCommand,
  shellGlobTargetsProtectedPath,
  unresolvedExpansionReason
// `.ts` rather than the `.js` specifier the TypeScript sources use: this file is
// plain ESM, so the loader resolves what is actually on disk.
} from "../packages/piagent-core/extensions/shell-reach.ts";
import { effectiveProtectedPaths, loadProjectContextIndexPolicy } from "../packages/piagent-core/extensions/context-index-policy.js";

const platformRoot = path.resolve(import.meta.dirname, "..");

function usage() {
  return [
    "Usage: piagent explain <command> [--project <path>] [--json]",
    "       piagent explain --scope [--project <path>] [--json]",
    "",
    "Prints a fail-closed static preflight for a shell command and what to do",
    "next. A static pass is indeterminate until the live Pi runtime evaluates",
    "Task Contract, scope, permission, lifecycle, approval, and budget state.",
    "Nothing is executed.",
    "",
    "  --scope            List the boundary in effect instead of judging a command",
    "  --project <path>   Evaluate against this project's profile (default: cwd)",
    "  --json             Machine-readable output",
    "  -h, --help         Show this help"
  ].join("\n");
}

function parseArgs(argv) {
  let project = process.cwd(), json = false, scope = false;
  const words = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") return { help: true };
    if (value === "--json") { json = true; continue; }
    if (value === "--scope") { scope = true; continue; }
    if (value === "--project") {
      const next = argv[index += 1];
      if (!next || next.startsWith("--")) throw new Error("--project needs a path");
      project = path.resolve(next);
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    words.push(value);
  }
  return { help: false, project, json, scope, command: words.join(" ").trim() };
}

// What the operator should do next. The guard states 74 refusals and only three
// of them say this, which is why a denial so often ends the conversation.
const REMEDY = {
  "protected-path": "Use an approved context projection if one is available. Direct access requires the operator to change the protected-path policy; task scope alone does not override it.",
  "protected-glob": "Name the file you mean instead of a pattern; a pattern is refused when any name it can match is protected.",
  "resolved-protected": "The path resolves to a protected file through a link or a parent directory. Use the real path you intend.",
  "unresolved": "Write the path out, or put the expansion in its own argument, so the guard can see what is being opened.",
  "exec-policy": "This is refused by an exec-policy rule, not by a path. Change the command, or ask the operator to run it.",
  "runtime-required": "Run the command through the current Pi session. Only that runtime owns the Task Contract, scope, permission, lifecycle, approval, and budget facts needed for a final decision."
};

const RUNTIME_GATES = [
  "task-contract",
  "task-scope",
  "permission-profile",
  "lifecycle-control",
  "approval-state",
  "context-budget"
];

function explain(command, protectedPaths, policy, cwd) {
  const steps = [];
  const record = (name, hit, detail) => { steps.push({ step: name, matched: Boolean(hit), detail }); return hit; };

  const exec = evaluateExecPolicyCore(command, { policy, mode: "enforce" });
  record("exec-policy", exec.decision === "forbid", exec.reasons.length ? exec.reasons.join("; ") : "no rule matched");
  if (exec.decision === "forbid") {
    return { decision: "deny", kind: "exec-policy", confidence: "exact", reason: exec.reasons.join("; "), steps, exec };
  }

  const literal = findProtectedPathInCommand(command, protectedPaths);
  record("literal-path", literal, literal ? `${literal.candidate} matches ${literal.pattern}` : "no word names a protected path");
  if (literal) {
    return {
      decision: "deny", kind: "protected-path", confidence: "exact",
      reason: `Command touches protected path: ${literal.candidate} matches ${literal.pattern}`, steps, exec
    };
  }

  const glob = shellGlobTargetsProtectedPath(command, protectedPaths);
  record("glob", glob, glob ? `${glob.glob} can match ${glob.example} via ${glob.pattern}` : "no pattern can reach a protected name");
  if (glob) {
    return {
      decision: "deny", kind: "protected-glob",
      // A pattern is matched against generated examples of each protected
      // pattern, not against the filesystem, so this answers for names that may
      // not exist. That is deliberate, and worth saying out loud.
      confidence: "over-approximate",
      reason: `Command glob can target protected path: ${glob.glob} can match ${glob.example} via ${glob.pattern}`, steps, exec
    };
  }

  const resolved = findResolvedProtectedPathInCommand(cwd, command, protectedPaths);
  record("resolved-path", resolved, resolved ? `${resolved.candidate} resolves to ${resolved.resolved}` : "no candidate resolves onto a protected path");
  if (resolved) {
    return {
      decision: "deny", kind: "resolved-protected", confidence: "exact",
      reason: `Command resolves to protected path: ${resolved.candidate} resolves to ${resolved.resolved} matching ${resolved.pattern}`, steps, exec
    };
  }

  const unresolved = protectedPaths.length > 0 ? unresolvedPathExpansions(command) : [];
  record("unresolved-expansion", unresolved.length > 0, unresolved.length ? unresolved.join(", ") : "every path is resolvable");
  if (unresolved.length > 0) {
    return {
      decision: "deny", kind: "unresolved",
      // Nothing was proven to be protected here. The command is refused because
      // its target is unknowable before it runs, which is a different statement
      // and leads the operator to a different fix.
      confidence: "unknown-target",
      reason: unresolvedExpansionReason("Command", unresolved), steps, exec
    };
  }

  const staticDecision = exec.decision === "prompt" ? "confirm" : "allow";
  return {
    decision: "indeterminate", kind: "runtime-required", confidence: "runtime-required",
    staticDecision,
    reason: staticDecision === "confirm"
      ? `Static preflight requires confirmation (${exec.reasons.join("; ")}), but the live runtime may still block it.`
      : "Static preflight found no refusal. A final decision requires live session and task state.",
    remainingGates: RUNTIME_GATES,
    steps, exec
  };
}

function render(result, context) {
  const lines = [`decision: ${result.decision}`, ""];
  lines.push(`  reason      ${result.reason}`);
  lines.push(`  confidence  ${result.confidence}`);
  if (result.staticDecision) lines.push(`  static      ${result.staticDecision}`);
  lines.push(`  remedy      ${REMEDY[result.kind] ?? REMEDY["runtime-required"]}`);
  if (result.remainingGates?.length) lines.push(`  still needs ${result.remainingGates.join(", ")}`);
  lines.push("", "  static chain (the order the guard asks these):");
  for (const step of result.steps) {
    lines.push(`    ${step.matched ? "HIT " : "    "} ${step.step.padEnd(20)} ${step.detail}`);
  }
  lines.push("", `  profile     ${context.profileSource} (${context.profilePath})`);
  lines.push(`  protected   ${context.protectedPaths.length} patterns in effect`);
  return lines.join("\n");
}

function renderScope(loaded, effective) {
  const lines = ["boundary in effect", ""];
  lines.push(`  profile     ${loaded.profileSource} (${loaded.profilePath})`);
  lines.push(`  mode        ${loaded.profile.mode ?? "unset"}`);
  if (typeof loaded.profile.displayName === "string") lines.push(`  project     ${loaded.profile.displayName}`);
  // Packs are `{name, version}` records, not names, so joining them raw printed
  // `[object Object]` where the operator expected to read what is loaded.
  const packs = (Array.isArray(loaded.profile.capabilityPacks) ? loaded.profile.capabilityPacks : [])
    .map((pack) => (pack && typeof pack === "object" ? `${pack.name}@${pack.version}` : String(pack)));
  lines.push(`  packs       ${packs.length > 0 ? packs.join(", ") : "none"}`);
  for (const [label, key] of [
    ["shell", "shellProtectedPaths"],
    ["read", "readProtectedPaths"],
    ["write", "writeProtectedPaths"],
    ["read-only", "readOnlyPaths"]
  ]) {
    const values = effective[key];
    lines.push("", `  ${label} (${values.length})`);
    for (const value of values) lines.push(`    ${value}`);
    if (values.length === 0) lines.push("    (none)");
  }
  return lines.join("\n");
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`FAIL: ${error.message}\n\n${usage()}`);
  process.exit(2);
}
if (parsed.help) { process.stdout.write(`${usage()}\n`); process.exit(0); }
if (!parsed.command && !parsed.scope) { console.error(`FAIL: nothing to explain\n\n${usage()}`); process.exit(2); }

try {
  const loaded = loadProjectContextIndexPolicy(platformRoot, parsed.project, { profilePath: process.env.PIAGENT_PROFILE });
  const effective = effectiveProtectedPaths(loaded.policy, loaded.profile);
  const protectedPaths = effective.shellProtectedPaths;
  if (parsed.scope) {
    // The boundary is otherwise only visible by running into it.
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({
        profileSource: loaded.profileSource, profilePath: loaded.profilePath,
        mode: loaded.profile.mode ?? null, capabilityPacks: loaded.profile.capabilityPacks ?? [], ...effective
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderScope(loaded, effective)}\n`);
    }
    process.exit(0);
  }
  const result = explain(parsed.command, protectedPaths, loaded.policy, parsed.project);
  const context = { profileSource: loaded.profileSource, profilePath: loaded.profilePath, protectedPaths };
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({
      command: parsed.command, decision: result.decision, kind: result.kind, confidence: result.confidence,
      reason: result.reason, remedy: REMEDY[result.kind] ?? REMEDY["runtime-required"],
      staticDecision: result.staticDecision ?? null,
      remainingGates: result.remainingGates ?? [], steps: result.steps,
      protectedPatternCount: protectedPaths.length, profileSource: loaded.profileSource
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(result, context)}\n`);
  }
  // Exit status is a permission signal for existing shell callers: 0 is reserved
  // for commands that are conclusively allowed. This standalone process can no
  // longer make that claim; 1 is a conclusive static denial and 2 means the live
  // runtime still has to decide.
  process.exit(result.decision === "deny" ? 1 : 2);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
