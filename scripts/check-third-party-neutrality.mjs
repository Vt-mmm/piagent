#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exactFiles = [
  "governance/piagent-webui/10-master-plan.md",
  "governance/piagent-webui/40-session-hub-master-plan.md",
  "governance/piagent-webui/STATUS.md"
];
const directories = ["governance/piagent-webui/decisions", "packages/piagent-webui/client/src"];
const comparisonBrands = /\b(?:ChatGPT|OpenClaw|Open WebUI|Claude Desktop|9Router)\b/g;

function filesIn(repositoryRoot, directory) {
  return fs.readdirSync(path.join(repositoryRoot, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:md|tsx?|css)$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

export function inspectThirdPartyNeutrality(repositoryRoot = root) {
  const candidates = [...exactFiles, ...directories.flatMap((directory) => filesIn(repositoryRoot, directory))]
    .filter((file) => !file.includes("/decisions/WUI") || /\/decisions\/WUI5-/.test(file));
  const violations = [];
  for (const file of candidates) {
    const text = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    for (const match of text.matchAll(comparisonBrands)) {
      const line = text.slice(0, match.index).split("\n").length;
      violations.push({ file, line, keyword: match[0] });
    }
  }
  return { ok: violations.length === 0, checkedFiles: candidates.length, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectThirdPartyNeutrality();
  if (!result.ok) {
    process.stderr.write(`FAIL: third-party comparison branding found\n${result.violations
      .map((item) => `- ${item.file}:${item.line} ${item.keyword}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS: ${result.checkedFiles} active WebUI files use provider-neutral product language\n`);
}
