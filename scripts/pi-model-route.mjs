#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { capturePiModelCatalog } from "./model-catalog.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { classifyContextTask } from "../packages/piagent-core/extensions/context-engine.js";
import { matchesProtectedPath } from "../packages/piagent-core/extensions/policy-core.js";
import { routeParentModel } from "../packages/piagent-core/runtime/model/model-route-policy.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";

const platformRoot = fileURLToPath(new URL("..", import.meta.url));

function usage() {
  process.stdout.write(`Usage:
  piagent-route --prompt <task> [--objective intelligence|balance|cost] [--json]
  piagent-route --prompt-file <file> [--execute --yes] [--] [pi args...]

Classifies one fresh task before Pi starts, checks Pi's authenticated catalog,
and recommends an exact model/effort. --execute is an explicit prelaunch action;
it refuses pins, blocked preflight, missing catalog entries, and unsafe ambiguity.
The task text is never written to Piagent route evidence.
`);
}

function fail(message) { throw Object.assign(new Error(message), { exitCode: 2 }); }
function git(args) { const value = spawnSync("git", args, { encoding: "utf8" }); return value.status === 0; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } }
function stringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : []; }
function profileFacts() {
  const basePolicy = readJson(new URL("../packages/piagent-core/policies/base-policy.json", import.meta.url)) ?? {};
  const stored = readJson(".pi/piagent-profile.json");
  let profile = stored, resolved = true;
  try {
    if (stored) profile = resolveProjectProfileDocument(platformRoot, stored).profile;
  } catch { resolved = false; profile = undefined; }
  const profileMode = String(profile?.mode ?? profile?.projectId ?? "").trim() || null;
  let verifierReady = Object.values(profile?.verifyCommands ?? {}).some((commands) => Array.isArray(commands) && commands.some((command) => typeof command === "string" && command.trim()));
  try {
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
    verifierReady ||= ["verify", "test", "typecheck", "check"].some((name) => typeof manifest.scripts?.[name] === "string");
  } catch {}
  return {
    profileMode,
    verifierReady,
    resolved,
    protectedPaths: [...new Set([...stringArray(basePolicy.protectedPaths), ...stringArray(profile?.protectedPaths)])]
  };
}

function parse(argv) {
  const options = { prompt: "", promptFile: "", objective: "balance", json: false, execute: false, yes: false, pinned: false, currentModel: "openai-codex/gpt-5.6-sol", currentEffort: "high", passthrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") { options.passthrough = argv.slice(index + 1); break; }
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    if (["--prompt", "--prompt-file", "--objective", "--current-model", "--current-effort"].includes(arg)) {
      if (!argv[index + 1]) fail(`${arg} requires a value`);
      const field = { "--prompt": "prompt", "--prompt-file": "promptFile", "--objective": "objective", "--current-model": "currentModel", "--current-effort": "currentEffort" }[arg];
      options[field] = argv[++index];
    } else if (arg === "--json") options.json = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--pinned") options.pinned = true;
    else fail(`unknown option ${arg}`);
  }
  if (!options.prompt && !options.promptFile) fail("provide exactly one of --prompt or --prompt-file");
  if (options.prompt && options.promptFile) fail("provide exactly one of --prompt or --prompt-file");
  if (!["intelligence", "balance", "cost"].includes(options.objective)) fail("--objective must be intelligence, balance, or cost");
  if (options.execute && !options.yes) fail("--execute requires --yes because it starts a provider-backed Pi task");
  if (options.passthrough.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))) fail("pass --pinned instead of combining router execution with a Pi --model override");
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  const request = options.prompt || fs.readFileSync(options.promptFile, "utf8").trim();
  if (!request) fail("task prompt is empty");
  const profile = profileFacts(), gitReady = git(["rev-parse", "--is-inside-work-tree"]);
  const requestedPaths = classifyContextTask(request).paths;
  const protectedTarget = requestedPaths.some((candidate) => matchesProtectedPath(candidate, profile.protectedPaths));
  const catalogReport = capturePiModelCatalog({ offline: false, provider: "openai-codex" });
  const catalog = {
    schemaVersion: 1, capturedAt: catalogReport.capturedAt, source: "authenticated-catalog", availability: catalogReport.availability,
    models: catalogReport.models.map((model) => ({ provider: model.provider, modelId: model.modelId, contextWindow: model.contextWindow, reasoning: model.reasoning, imageInput: model.imageInput, supportedThinkingLevels: model.supportedThinkingLevels })),
    warnings: catalogReport.warnings
  };
  const [currentProvider, ...modelParts] = options.currentModel.split("/");
  const currentModelId = modelParts.join("/");
  if (!currentProvider || !currentModelId) fail("--current-model must be provider/model");
  const features = extractTaskFeatures({
    request, profileMode: profile.profileMode, projectShape: [], gitReady, dirtyTree: gitReady ? !git(["diff", "--quiet"]) : null,
    verifierReady: profile.verifierReady, contextPressure: null, activeTaskState: "none", runtimeCapabilitiesKnown: catalog.availability === "authenticated" && profile.resolved,
    userPinnedProvider: currentProvider, userPinnedModel: currentModelId, userPinnedEffort: options.currentEffort, protectedTarget
  });
  const decision = routeParentModel({
    features, catalog, mode: options.execute ? "auto" : "recommend", objective: options.objective,
    selectionSource: options.pinned ? "explicit-user-pin" : "workspace-default",
    current: { provider: currentProvider, modelId: currentModelId, effort: options.currentEffort }, freshTaskBoundary: true, hostBoundary: options.execute ? "prelaunch" : "unavailable"
  });
  const report = { schemaVersion: 1, featureHash: features.featureHash, decision, promptStored: false, providerCalls: options.execute ? "task-only-after-route" : 0 };
  if (options.json || !options.execute) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!options.execute) process.exit(0);
  if (!decision.enforced || !decision.provider || !decision.modelId || !decision.effort) fail(`route cannot execute: ${decision.disposition}; ${decision.reasonCodes.join(",")}`);
  const child = spawnSync("pi", [...options.passthrough, "--model", `${decision.provider}/${decision.modelId}`, "--thinking", decision.effort, request], {
    stdio: "inherit",
    env: { ...process.env, PIAGENT_PARENT_ROUTING: "auto", PIAGENT_MODEL_SELECTION_SOURCE: "router-selected", PIAGENT_ROUTING_DECISION_DIGEST: decision.decisionDigest }
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
} catch (error) {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(error?.exitCode ?? 1);
}
