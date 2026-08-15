#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "architecture", "layers.json");
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

function normalizeRelative(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function sourceLineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function readConfig(configPath = defaultConfigPath) {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.layers)) {
    throw new Error(`Unsupported architecture config: ${normalizeRelative(path.relative(repoRoot, configPath))}`);
  }
  return parsed;
}

function layerFor(relativeFile, config) {
  const normalized = normalizeRelative(relativeFile);
  for (const layer of config.layers) {
    if ((layer.files ?? []).includes(normalized)) return layer.name;
    if ((layer.roots ?? []).some((root) => normalized === root || normalized.startsWith(`${root}/`))) return layer.name;
  }
  return undefined;
}

function walkSources(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  return files.sort();
}

function moduleSpecifiers(file, text) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[\w*{},\s]+?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function inspectArchitecture({ root = repoRoot, config = readConfig() } = {}) {
  const errors = [];
  const files = [
    ...walkSources(path.join(root, "packages", "piagent-core")),
    ...walkSources(path.join(root, "packages", "piagent-webui")),
    ...walkSources(path.join(root, "scripts"))
  ];
  const counts = {};

  for (const absolute of files) {
    const relative = normalizeRelative(path.relative(root, absolute));
    const layer = layerFor(relative, config);
    if (!layer) {
      errors.push(`${relative}: source file is not assigned to an architecture layer`);
      continue;
    }
    counts[layer] = (counts[layer] ?? 0) + 1;
    const text = fs.readFileSync(absolute, "utf8");
    const lineCount = sourceLineCount(text);
    const budget = config.lineBudgets.files[relative] ?? config.lineBudgets.defaults[layer];
    if (Number.isInteger(budget) && lineCount > budget) {
      errors.push(`${relative}: ${lineCount} lines exceeds the ${layer} budget of ${budget}`);
    }

    for (const specifier of moduleSpecifiers(relative, text)) {
      if (!specifier.startsWith(".")) continue;
      const target = normalizeRelative(path.relative(root, path.resolve(path.dirname(absolute), specifier)));
      const targetLayer = layerFor(target, config);
      if (!targetLayer) continue;
      const allowed = config.allowedDependencies[layer] ?? [];
      if (!allowed.includes(targetLayer)) {
        errors.push(`${relative}: ${layer} cannot import ${targetLayer} module ${specifier}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, files: files.length, layers: counts };
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
    result = inspectArchitecture();
  } catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!result.ok) {
    process.stderr.write(`FAIL: architecture check found ${result.errors.length} problem(s)\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(json
    ? `${JSON.stringify(result)}\n`
    : `PASS: ${result.files} source files respect architecture boundaries and line budgets\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

export { inspectArchitecture, layerFor, main, readConfig, sourceLineCount };
