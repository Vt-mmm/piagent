#!/usr/bin/env node
// Imports instruction files written for other agents into AGENTS.md.
//
// AGENTS.md is the format this platform reads, and the one the wider ecosystem
// converged on, so the flow is deliberately one-way: legacy formats are folded
// in and then stop being a second source of truth.
//
// Imported text is DATA, not instruction. It is quoted into a clearly labelled
// section and never interpreted here: a repository's instruction file is
// attacker-controlled in the general case, and anything that could change
// protected paths, permission profile, or verify commands is reported for a
// human to act on rather than applied.
import fs from "node:fs";
import path from "node:path";

// Ordered: earlier sources win a conflict. AGENTS.md itself always outranks
// every import, which is what makes repeated runs safe.
const SOURCES = [
  { id: "claude-md", label: "CLAUDE.md", kind: "file", rel: "CLAUDE.md" },
  { id: "claude-rules", label: ".claude/rules", kind: "dir", rel: ".claude/rules", ext: [".md"] },
  { id: "cursor-rules", label: ".cursor/rules", kind: "dir", rel: ".cursor/rules", ext: [".md", ".mdc"] },
  { id: "copilot", label: ".github/copilot-instructions.md", kind: "file", rel: ".github/copilot-instructions.md" }
];

const IMPORT_HEADING = "## Imported agent instructions";

// Directives that would change what the guard enforces. Matching text is still
// imported verbatim, but it is surfaced so a human decides rather than having
// the profile quietly rewritten by a file from an untrusted repository.
const SENSITIVE_PATTERNS = [
  { id: "protected-paths", pattern: /\bprotected\s*paths?\b/i },
  { id: "permission-profile", pattern: /\b(trusted-full-access|full[- ]access|permission\s*profile)\b/i },
  { id: "verify-commands", pattern: /\bverify\s*commands?\b/i },
  { id: "policy-override", pattern: /\b(ignore|disregard|override|bypass)\b[^.\n]{0,40}\b(rule|policy|instruction|guard|restriction)/i },
  { id: "secret-handling", pattern: /\b(\.env|auth\.json|api[_ -]?key|secret|credential)/i }
];

function usage() {
  console.log(`Usage:
  piagent-import-instructions [project-path] [--apply]

Folds instruction files written for other agents into AGENTS.md.

  (default)   Dry run. Prints the plan, conflicts, and flagged directives.
  --apply     Append the imported section to AGENTS.md.

Sources, in precedence order (earlier wins):
${SOURCES.map((source, index) => `  ${index + 1}. ${source.label}`).join("\n")}

AGENTS.md always outranks every import, so re-running never overwrites
content you have already reviewed.`);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}
const apply = args.includes("--apply");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length > 1) {
  console.error(`Expected at most one project path, received ${positional.length}.`);
  process.exit(2);
}
const projectPath = path.resolve(positional[0] ?? process.cwd());
if (!fs.existsSync(projectPath)) {
  console.error(`Project path does not exist: ${projectPath}`);
  process.exit(2);
}

function readIfRegularFile(absolute) {
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return undefined;
  return fs.readFileSync(absolute, "utf8");
}

function collect(source) {
  const absolute = path.join(projectPath, source.rel);
  if (!fs.existsSync(absolute)) return [];
  if (source.kind === "file") {
    const text = readIfRegularFile(absolute);
    return text === undefined ? [] : [{ origin: source.rel, sourceId: source.id, text }];
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(absolute)
    .filter((name) => source.ext.some((ext) => name.endsWith(ext)))
    .sort()
    .map((name) => {
      const text = readIfRegularFile(path.join(absolute, name));
      return text === undefined ? undefined : { origin: path.posix.join(source.rel, name), sourceId: source.id, text };
    })
    .filter(Boolean);
}

// A heading is the unit of conflict: two sources describing "Build commands"
// differently is the case a human needs to see.
function headings(text) {
  return text
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#+\s+/, "").trim().toLowerCase());
}

const documents = SOURCES.flatMap(collect);
const agentsPath = path.join(projectPath, "AGENTS.md");
const agentsText = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
const alreadyImported = agentsText.includes(IMPORT_HEADING);

const flagged = [];
for (const document of documents) {
  for (const line of document.text.split("\n")) {
    for (const { id, pattern } of SENSITIVE_PATTERNS) {
      if (pattern.test(line)) flagged.push({ origin: document.origin, rule: id, line: line.trim().slice(0, 200) });
    }
  }
}

const seen = new Map();
const conflicts = [];
const agentsHeadings = new Set(headings(agentsText));
for (const document of documents) {
  for (const heading of headings(document.text)) {
    if (agentsHeadings.has(heading)) {
      conflicts.push({ heading, origin: document.origin, resolution: "AGENTS.md wins" });
      continue;
    }
    if (seen.has(heading)) {
      conflicts.push({ heading, origin: document.origin, resolution: `${seen.get(heading)} wins` });
      continue;
    }
    seen.set(heading, document.origin);
  }
}

function renderImportSection() {
  const lines = [
    "",
    IMPORT_HEADING,
    "",
    "Folded in from instruction files written for other agents. Treated as",
    "reference material: rules here do not change protected paths, permission",
    "profile, or verify commands unless a maintainer moves them into the",
    "sections above.",
    ""
  ];
  for (const document of documents) {
    lines.push(`### From \`${document.origin}\``, "");
    lines.push(document.text.trimEnd(), "");
  }
  return lines.join("\n");
}

const report = {
  ok: true,
  projectPath,
  sourcesFound: documents.map((document) => document.origin),
  conflicts,
  flaggedDirectives: flagged,
  alreadyImported
};

if (documents.length === 0) {
  console.log(JSON.stringify({ ...report, imported: false, reason: "no instruction files from other agents found" }, null, 2));
  process.exit(0);
}

if (alreadyImported) {
  console.log(JSON.stringify({
    ...report,
    imported: false,
    reason: "AGENTS.md already contains an imported section; remove it first to re-import"
  }, null, 2));
  process.exit(0);
}

if (!apply) {
  console.log(JSON.stringify({
    ...report,
    dryRun: true,
    wouldAppendTo: "AGENTS.md",
    wouldAppendBytes: Buffer.byteLength(renderImportSection()),
    next: flagged.length > 0
      ? "review flaggedDirectives, then re-run with --apply"
      : "re-run with --apply"
  }, null, 2));
  process.exit(0);
}

fs.writeFileSync(agentsPath, `${agentsText.trimEnd()}\n${renderImportSection()}`);

console.log(JSON.stringify({
  ...report,
  imported: true,
  appendedTo: "AGENTS.md",
  next: flagged.length > 0
    ? "review flaggedDirectives; nothing in them has been applied to the profile"
    : "review AGENTS.md and delete the now-redundant source files when satisfied"
}, null, 2));
