import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import {
  appendContextTelemetry,
  buildContextEfficiencyReport,
  buildContextIndexV2,
  buildContextPack,
  buildTestImpact,
  classifyContextTask,
  contextEnginePaths,
  contextIndexV2Status,
  ensureContextIndexV2,
  searchContextIndexV2
} from "../packages/piagent-core/extensions/context-engine.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-context-engine-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(cwd, "src", "math.ts"), [
    "export function calculateInvoiceTotal(values: number[]): number {",
    "  return values.reduce((total, value) => total + value, 0);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "service.ts"), [
    "import { calculateInvoiceTotal } from './math';",
    "",
    "export class InvoiceService {",
    "  total(values: number[]): number {",
    "    return calculateInvoiceTotal(values);",
    "  }",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "tests", "math.test.ts"), [
    "import { calculateInvoiceTotal } from '../src/math';",
    "",
    "test('invoice total', () => {",
    "  expect(calculateInvoiceTotal([1, 2])).toBe(3);",
    "});",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=do-not-index\n");
  return cwd;
}

function runContextCli(cwd, args) {
  return spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts", "context-engine.mjs"),
    ...args,
    "--project",
    cwd,
    "--json"
  ], {
    cwd,
    encoding: "utf8"
  });
}

function writeProjectProfile(cwd, profile) {
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "piagent-profile.json"),
    `${JSON.stringify(profile, null, 2)}\n`
  );
}

test("classifies task signals without calling a model", () => {
  const result = classifyContextTask("Fix auth validation in src/session.ts before release");
  assert.equal(result.lane, "high-risk");
  assert.equal(result.workflow, "release");
  assert.deepEqual(result.paths, ["src/session.ts"]);
  assert.ok(result.terms.includes("validation"));
  assert.equal(result.promptHash.length, 64);
  assert.equal(classifyContextTask("Show current session token usage").workflow, "usage");
  assert.equal(classifyContextTask("Optimize token usage in src/context.ts").workflow, "task");
});

test("fails closed when a content API omits its exclusion policy", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const operations = [
    ["buildContextIndexV2", () => buildContextIndexV2(cwd)],
    ["ensureContextIndexV2", () => ensureContextIndexV2(cwd)],
    ["searchContextIndexV2", () => searchContextIndexV2(cwd, "invoice")],
    ["buildContextPack", () => buildContextPack(cwd, "invoice")],
    ["buildTestImpact", () => buildTestImpact(cwd, ["src/math.ts"])]
  ];

  for (const [name, operation] of operations) {
    await assert.rejects(operation, new RegExp(`${name} requires an explicit excludePatterns array`));
  }
});

test("builds an incremental local index and retrieves symbols with hybrid evidence", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });

  const first = await buildContextIndexV2(cwd, { excludePatterns: [] });
  assert.equal(first.files, 4);
  assert.ok(first.symbols >= 2);
  assert.equal(first.changed, 4);
  assert.equal(fs.existsSync(contextEnginePaths(cwd).database), true);

  const second = await buildContextIndexV2(cwd, { excludePatterns: [] });
  assert.equal(second.changed, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.reused, 4);

  const search = await searchContextIndexV2(cwd, "calculateInvoiceTotal implementation", {
    limit: 5,
    excludePatterns: []
  });
  assert.equal(search.results[0].path, "src/math.ts");
  assert.ok(search.results[0].sources.includes("symbol"));
  assert.ok(["high", "medium"].includes(search.confidence));
  assert.equal(search.results.some((result) => result.path === ".env"), false);

  const status = await contextIndexV2Status(cwd);
  assert.equal(status.exists, true);
  assert.equal(status.files, 4);
  assert.equal(status.stale, false);

  fs.appendFileSync(path.join(cwd, "src", "math.ts"), "// changed\n");
  const stale = await contextIndexV2Status(cwd);
  assert.equal(stale.stale, true);
  assert.ok(stale.stalePaths.includes("src/math.ts"));

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  fs.writeFileSync(path.join(cwd, "src", "new-module.ts"), "export const newModule = true;\n");
  const added = await contextIndexV2Status(cwd);
  assert.equal(added.stale, true);
  assert.ok(added.stalePaths.includes("src/new-module.ts"));
});

test("packs ranked snippets to a hard token budget and reports low-confidence finder fallback", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const pack = await buildContextPack(cwd, "invoice total calculation", {
    budgetTokens: 500,
    excludePatterns: []
  });
  assert.ok(pack.estimatedTokens <= 500);
  assert.match(pack.text, /Repository map:/);
  assert.match(pack.text, /src\/math\.ts/);

  const missing = await buildContextPack(cwd, "quantum zebra subsystem", {
    budgetTokens: 400,
    excludePatterns: []
  });
  assert.equal(missing.finderRecommended, true);
  assert.match(missing.finderRequest, /bounded read-only finder pass/);
});

test("keeps configured protected paths out of both the index and stale signal", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "private.ts"), "export const privateValue = 'secret';\n");

  await buildContextIndexV2(cwd, { excludePatterns: ["src/private.ts"] });
  const status = await contextIndexV2Status(cwd);
  const search = await searchContextIndexV2(cwd, "privateValue", {
    excludePatterns: ["src/private.ts"]
  });
  assert.equal(status.stale, false);
  assert.equal(search.results.some((result) => result.path === "src/private.ts"), false);
});

test("CLI rebuild excludes readOnlyPaths from search and packs", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "backend", "credentials.ts"),
    "export const DB_URL = 'postgres://user:HUNTER2@prod/db';\n"
  );
  writeProjectProfile(cwd, {
    schemaVersion: 1,
    projectId: "readonly-fixture",
    displayName: "Readonly Fixture",
    mode: "custom",
    protectedPaths: [],
    readOnlyPaths: ["backend/**"]
  });

  const rebuild = runContextCli(cwd, ["rebuild"]);
  assert.equal(rebuild.status, 0, rebuild.stderr);
  const search = runContextCli(cwd, ["search", "HUNTER2"]);
  assert.equal(search.status, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).results.some((result) => result.path === "backend/credentials.ts"), false);
  const allowedSearch = runContextCli(cwd, ["search", "calculateInvoiceTotal"]);
  assert.equal(allowedSearch.status, 0, allowedSearch.stderr);
  assert.equal(JSON.parse(allowedSearch.stdout).results.some((result) => result.path === "src/math.ts"), true);
  const pack = runContextCli(cwd, ["pack", "HUNTER2 production database"]);
  assert.equal(pack.status, 0, pack.stderr);
  assert.doesNotMatch(JSON.parse(pack.stdout).text, /HUNTER2|backend\/credentials\.ts/);
});

test("CLI resolves adapter extends before building context exclusions", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "data", "production"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "data", "production", "dump.sql"),
    "select 'ADAPTER_PROTECTED_VALUE' as production_secret;\n"
  );
  writeProjectProfile(cwd, {
    schemaVersion: 1,
    extends: "data",
    projectId: "data-fixture",
    displayName: "Data Fixture"
  });

  const rebuild = runContextCli(cwd, ["rebuild"]);
  assert.equal(rebuild.status, 0, rebuild.stderr);
  const search = runContextCli(cwd, ["search", "ADAPTER_PROTECTED_VALUE"]);
  assert.equal(search.status, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).results.some((result) => result.path === "data/production/dump.sql"), false);
});

test("CLI pack rebuilds an existing index when its exclusion policy differs", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "backend", "credentials.ts"),
    "export const LEGACY_INDEX_SECRET = 'STALE_POLICY_VALUE';\n"
  );
  writeProjectProfile(cwd, {
    schemaVersion: 1,
    projectId: "stale-policy-fixture",
    displayName: "Stale Policy Fixture",
    mode: "custom",
    protectedPaths: [],
    readOnlyPaths: ["backend/**"]
  });
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const pack = runContextCli(cwd, ["pack", "STALE_POLICY_VALUE"]);
  assert.equal(pack.status, 0, pack.stderr);
  const parsed = JSON.parse(pack.stdout);
  assert.doesNotMatch(parsed.text, /STALE_POLICY_VALUE|backend\/credentials\.ts/);
  assert.equal(parsed.status.policyStale, false);
});

test("does not index or pack a source-shaped symlink outside the project", async (t) => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-context-outside-"));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const externalFile = path.join(outside, "external.ts");
  fs.writeFileSync(externalFile, "export const OUTSIDE_PROJECT_VALUE = 'must-not-enter-context';\n");
  try {
    fs.symlinkSync(externalFile, path.join(cwd, "src", "outside.ts"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symlinks are unavailable on this platform");
      return;
    }
    throw error;
  }
  execFileSync("git", ["init", "-q"], { cwd });

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  const search = await searchContextIndexV2(cwd, "OUTSIDE_PROJECT_VALUE", { excludePatterns: [] });
  const pack = await buildContextPack(cwd, "OUTSIDE_PROJECT_VALUE", {
    budgetTokens: 500,
    excludePatterns: []
  });

  assert.equal(search.results.some((result) => result.path === "src/outside.ts"), false);
  assert.doesNotMatch(pack.text, /OUTSIDE_PROJECT_VALUE|must-not-enter-context|src\/outside\.ts/);
});

test("does not search or pack a stale index entry after its file becomes a symlink", async (t) => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-context-outside-"));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const indexedPath = path.join(cwd, "src", "linked.ts");
  const externalFile = path.join(outside, "external.ts");
  fs.writeFileSync(indexedPath, "export const LEGACY_SYMLINK_VALUE = 'local-before-link';\n");
  fs.writeFileSync(externalFile, "export const LEGACY_SYMLINK_VALUE = 'outside-after-link';\n");
  await buildContextIndexV2(cwd, { excludePatterns: [] });
  fs.unlinkSync(indexedPath);
  try {
    fs.symlinkSync(externalFile, indexedPath);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symlinks are unavailable on this platform");
      return;
    }
    throw error;
  }

  const status = await contextIndexV2Status(cwd);
  const search = await searchContextIndexV2(cwd, "LEGACY_SYMLINK_VALUE", { excludePatterns: [] });
  const pack = await buildContextPack(cwd, "LEGACY_SYMLINK_VALUE", {
    budgetTokens: 500,
    excludePatterns: []
  });

  assert.equal(status.stale, true);
  assert.equal(search.results.some((result) => result.path === "src/linked.ts"), false);
  assert.doesNotMatch(pack.text, /LEGACY_SYMLINK_VALUE|outside-after-link|src\/linked\.ts/);
});

test("does not make intentionally skipped large or binary sources permanently stale", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "generated.ts"), "x".repeat(2_048));
  fs.writeFileSync(path.join(cwd, "src", "binary.ts"), Buffer.from([0, 1, 2, 3]));

  const build = await buildContextIndexV2(cwd, { maxFileBytes: 1_024, excludePatterns: [] });
  const status = await contextIndexV2Status(cwd);
  assert.equal(build.skippedLarge, 1);
  assert.equal(build.skippedBinary, 1);
  assert.equal(status.stale, false);
});

test("maps reverse imports and related tests for targeted verification", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const impact = await buildTestImpact(cwd, ["src/math.ts"], { excludePatterns: [] });
  assert.ok(impact.impactedFiles.some((file) => file.path === "src/service.ts"));
  assert.ok(impact.tests.includes("tests/math.test.ts"));
});

test("writes Agent Watch compatible telemetry and transparent context waste metrics", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  appendContextTelemetry(cwd, {
    event: "agent_prompt",
    sessionId: "session-1",
    activeTools: 30,
    systemPromptTokens: 10_000,
    toolSchemaTokens: 2_000
  });
  appendContextTelemetry(cwd, { event: "tool_call", toolName: "read", inputHash: "same", targetHash: "same" });
  appendContextTelemetry(cwd, { event: "tool_call", toolName: "read", inputHash: "same", targetHash: "same" });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", outputChars: 1_000, repeated: false });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", outputChars: 1_000, repeated: true });
  appendContextTelemetry(cwd, {
    event: "context_pack",
    sessionId: "session-1",
    confidence: "low",
    selectedPaths: ["src/math.ts", "src/service.ts"]
  });
  appendContextTelemetry(cwd, {
    event: "tool_call",
    sessionId: "session-1",
    toolName: "read",
    targetPath: "src/math.ts",
    inputHash: "math-read"
  });

  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.source, "piagent");
  assert.equal(report.metrics.duplicateReads, 1);
  assert.equal(report.metrics.duplicateOutputChars, 1_000);
  assert.equal(report.metrics.contextSelections, 2);
  assert.equal(report.metrics.contextSelectionsUsed, 1);
  assert.equal(report.metrics.contextUtilizationRate, 0.5);
  assert.ok(report.metrics.contextWasteScore > 0);
  assert.match(report.methodology.note, /not a quality verdict/);
  assert.match(report.methodology.retrievalFeedback, /Positive-only/);
  assert.equal(fs.existsSync(contextEnginePaths(cwd).report), true);
});

test("uses only evidenced positive feedback as a weak retrieval signal", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  appendContextTelemetry(cwd, {
    event: "context_pack",
    sessionId: "session-feedback",
    selectedPaths: ["src/math.ts", "src/service.ts"]
  });
  appendContextTelemetry(cwd, {
    event: "tool_call",
    sessionId: "session-feedback",
    toolName: "read",
    targetPath: "src/math.ts"
  });

  const search = await searchContextIndexV2(cwd, "invoice total", {
    limit: 5,
    excludePatterns: []
  });
  const used = search.results.find((result) => result.path === "src/math.ts");
  const unused = search.results.find((result) => result.path === "src/service.ts");
  assert.ok(used?.sources.includes("feedback"));
  assert.equal(unused?.sources.includes("feedback") ?? false, false);
});
