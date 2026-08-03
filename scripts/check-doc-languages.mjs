#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "docs", "languages.json");

function markdownRelativeLink(from, to) {
  const relative = path.relative(path.dirname(from), to).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function inspectDocLanguages(root = repoRoot) {
  const manifestFile = path.join(root, "docs", "languages.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.pairs)) {
    throw new Error("docs/languages.json has an unsupported schema");
  }
  const errors = [];
  const topics = new Set();
  for (const pair of manifest.pairs) {
    if (!pair.topic || topics.has(pair.topic)) errors.push(`duplicate or missing topic: ${pair.topic ?? "unknown"}`);
    topics.add(pair.topic);
    const en = path.join(root, pair.en);
    const vi = path.join(root, pair.vi);
    if (!fs.existsSync(en)) errors.push(`${pair.topic}: missing English file ${pair.en}`);
    if (!fs.existsSync(vi)) errors.push(`${pair.topic}: missing Vietnamese file ${pair.vi}`);
    if (!fs.existsSync(en) || !fs.existsSync(vi)) continue;
    const enText = fs.readFileSync(en, "utf8");
    const viText = fs.readFileSync(vi, "utf8");
    const viLink = markdownRelativeLink(en, vi).replace(/^\.\//, "");
    const enLink = markdownRelativeLink(vi, en).replace(/^\.\//, "");
    if (!enText.includes(viLink)) errors.push(`${pair.topic}: English file does not link to ${viLink}`);
    if (!viText.includes(enLink)) errors.push(`${pair.topic}: Vietnamese file does not link to ${enLink}`);
    if (!/[À-ỹĐđ]/u.test(viText)) errors.push(`${pair.topic}: Vietnamese file has no Vietnamese diacritics`);
  }
  return { ok: errors.length === 0, errors, pairs: manifest.pairs.length, terms: manifest.preservedTechnicalTerms };
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const unknown = argv.filter((argument) => argument !== "--json");
  if (unknown.length > 0) {
    process.stderr.write(`FAIL: unknown option ${unknown[0]}\n`);
    return 1;
  }
  let result;
  try {
    result = inspectDocLanguages();
  } catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!result.ok) {
    process.stderr.write(`FAIL: documentation language check found ${result.errors.length} problem(s)\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `PASS: ${result.pairs} EN/VI documentation pairs are complete\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

export { inspectDocLanguages, main, markdownRelativeLink };
