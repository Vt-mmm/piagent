#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const surfaces = ["README.md", "docs", "docs-site/content", "scripts/build-docs-site.mjs",
  "packages/piagent-core/README.md", "packages/piagent-core/prompts", "packages/piagent-core/mcp",
  "packages/piagent-core/extensions", "packages/piagent-core/runtime", "templates/project/AGENTS.md"];
const sourceNames = ["Codex CLI", "Claude CLI", "Claude Code"];
// Other agent products and projects. Public text describes a technique in its
// own words and names none of them; whole words only ("declined" is not one).
const otherAgents = /\b(?:Aider|SWE-agent|OpenHands|Oh My Pi|oh-my-pi|OpenClaw|OpenClaude|LangGraph|LangChain|Windsurf|Cline|Roo Code|Kilo Code|autoresearch)\b/g;
const prohibited = ["platform-migration", "codex-migration", "codex-parity", "benchmark-parity",
  "harness-migration", "agent-stuff", "mitsuhiko", "claude mcp", "codex mcp",
  "Codex-inspired", "Codex-grade", "Pi vs Codex", "vs Claude", "reference repo",
  "repo tham khảo", "nguồn tham khảo", "tham khảo"];
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function publicWordingViolations(file, text) {
  const pattern = new RegExp([...prohibited, ...sourceNames].map(escaped).join("|"), "gi");
  return [...text.matchAll(pattern), ...text.matchAll(otherAgents)].sort((a, b) => a.index - b.index).map(match => ({ file,
    line: text.slice(0, match.index).split("\n").length, keyword: match[0] }));
}

function filesIn(repositoryRoot, relative) {
  const absolute = path.join(repositoryRoot, relative);
  if (!fs.statSync(absolute).isDirectory()) return [relative];
  return fs.readdirSync(absolute).flatMap(name => filesIn(repositoryRoot, path.join(relative, name)));
}

export function inspectPublicWording(repositoryRoot = root) {
  const files = surfaces.flatMap(surface => filesIn(repositoryRoot, surface));
  const violations = files.flatMap(file => publicWordingViolations(file, fs.readFileSync(path.join(repositoryRoot, file), "utf8")));
  return { ok: violations.length === 0, checkedFiles: files.length, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectPublicWording();
  if (!result.ok) {
    process.stderr.write(`Public docs contain non-neutral platform wording\n${result.violations
      .map(item => `- ${item.file}:${item.line} ${item.keyword}`).join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`PASS: ${result.checkedFiles} public surfaces preserve neutral copy and research provenance\n`);
}
