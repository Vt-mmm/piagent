#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  buildContextEfficiencyReport,
  buildContextIndexV2,
  buildContextPack,
  buildTestImpact,
  contextIndexV2Status,
  ensureContextIndexV2,
  searchContextIndexV2
} from "../packages/piagent-core/extensions/context-engine.js";
import { loadProjectContextIndexPolicy } from "../packages/piagent-core/extensions/context-index-policy.js";

const platformRoot = path.resolve(import.meta.dirname, "..");
function usage() {
  return [
    "Pi Context Engine",
    "",
    "Usage:",
    "  piagent-context status [--project <path>] [--json]",
    "  piagent-context rebuild [--project <path>] [--json]",
    "  piagent-context search <query> [--project <path>] [--json]",
    "  piagent-context pack <task> [--tokens <n>] [--project <path>] [--json]",
    "  piagent-context impact [file ...] [--project <path>] [--json]",
    "  piagent-context efficiency [--project <path>] [--json]",
    "",
    "All index and telemetry data stays under .pi/piagent-state/context-engine/."
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "--help" || args[0] === "-h") return { help: true };
  const command = args.shift() ?? "status";
  let project = process.cwd();
  let json = false;
  let tokens = 6_000;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--project" && args[index + 1]) {
      project = path.resolve(args[++index]);
    } else if (value === "--tokens" && args[index + 1]) {
      tokens = Number(args[++index]);
    } else if (value === "--json") {
      json = true;
    } else if (value === "--help" || value === "-h") {
      return { help: true };
    } else {
      values.push(value);
    }
  }
  return { command, project, json, tokens, values };
}

function print(value, json) {
  if (json || typeof value === "string") {
    process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

if (!fs.existsSync(parsed.project) || !fs.statSync(parsed.project).isDirectory()) {
  process.stderr.write(`Project directory not found: ${parsed.project}\n`);
  process.exit(1);
}

try {
  const contextPolicy = ["status", "show", "rebuild", "build", "refresh", "search", "pack", "impact", "tests"]
    .includes(parsed.command)
    ? loadProjectContextIndexPolicy(platformRoot, parsed.project, {
        profilePath: process.env.PIAGENT_PROFILE
      })
    : undefined;
  const excludePatterns = contextPolicy?.excludePatterns ?? [];
  if (["status", "show"].includes(parsed.command)) {
    print(await contextIndexV2Status(parsed.project, { excludePatterns }), parsed.json);
  } else if (["rebuild", "build", "refresh"].includes(parsed.command)) {
    print(await buildContextIndexV2(parsed.project, { excludePatterns }), parsed.json);
  } else if (parsed.command === "search") {
    const query = parsed.values.join(" ").trim();
    if (!query) throw new Error("search requires a query");
    await ensureContextIndexV2(parsed.project, { excludePatterns, rebuildMissing: true });
    print(await searchContextIndexV2(parsed.project, query, { limit: 15, excludePatterns }), parsed.json);
  } else if (parsed.command === "pack") {
    const query = parsed.values.join(" ").trim();
    if (!query) throw new Error("pack requires a task or query");
    await ensureContextIndexV2(parsed.project, { excludePatterns, rebuildMissing: true });
    const pack = await buildContextPack(parsed.project, query, {
      budgetTokens: parsed.tokens,
      includeCode: true,
      excludePatterns
    });
    print(parsed.json ? pack : pack.text, parsed.json);
  } else if (["impact", "tests"].includes(parsed.command)) {
    await ensureContextIndexV2(parsed.project, { excludePatterns, rebuildMissing: false });
    print(await buildTestImpact(parsed.project, parsed.values, { excludePatterns }), parsed.json);
  } else if (["efficiency", "stats", "waste"].includes(parsed.command)) {
    print(buildContextEfficiencyReport(parsed.project), parsed.json);
  } else {
    process.stderr.write(`${usage()}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
