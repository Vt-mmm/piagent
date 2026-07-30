import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  searchContextIndexV2
} from "../packages/piagent-core/extensions/context-engine.js";

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

test("builds an incremental local index and retrieves symbols with hybrid evidence", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });

  const first = await buildContextIndexV2(cwd);
  assert.equal(first.files, 4);
  assert.ok(first.symbols >= 2);
  assert.equal(first.changed, 4);
  assert.equal(fs.existsSync(contextEnginePaths(cwd).database), true);

  const second = await buildContextIndexV2(cwd);
  assert.equal(second.changed, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.reused, 4);

  const search = await searchContextIndexV2(cwd, "calculateInvoiceTotal implementation", { limit: 5 });
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

  await buildContextIndexV2(cwd);
  fs.writeFileSync(path.join(cwd, "src", "new-module.ts"), "export const newModule = true;\n");
  const added = await contextIndexV2Status(cwd);
  assert.equal(added.stale, true);
  assert.ok(added.stalePaths.includes("src/new-module.ts"));
});

test("packs ranked snippets to a hard token budget and reports low-confidence finder fallback", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd);

  const pack = await buildContextPack(cwd, "invoice total calculation", { budgetTokens: 500 });
  assert.ok(pack.estimatedTokens <= 500);
  assert.match(pack.text, /Repository map:/);
  assert.match(pack.text, /src\/math\.ts/);

  const missing = await buildContextPack(cwd, "quantum zebra subsystem", { budgetTokens: 400 });
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
  const search = await searchContextIndexV2(cwd, "privateValue");
  assert.equal(status.stale, false);
  assert.equal(search.results.some((result) => result.path === "src/private.ts"), false);
});

test("does not make intentionally skipped large or binary sources permanently stale", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "generated.ts"), "x".repeat(2_048));
  fs.writeFileSync(path.join(cwd, "src", "binary.ts"), Buffer.from([0, 1, 2, 3]));

  const build = await buildContextIndexV2(cwd, { maxFileBytes: 1_024 });
  const status = await contextIndexV2Status(cwd);
  assert.equal(build.skippedLarge, 1);
  assert.equal(build.skippedBinary, 1);
  assert.equal(status.stale, false);
});

test("maps reverse imports and related tests for targeted verification", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd);

  const impact = await buildTestImpact(cwd, ["src/math.ts"]);
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
  await buildContextIndexV2(cwd);

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

  const search = await searchContextIndexV2(cwd, "invoice total", { limit: 5 });
  const used = search.results.find((result) => result.path === "src/math.ts");
  const unused = search.results.find((result) => result.path === "src/service.ts");
  assert.ok(used?.sources.includes("feedback"));
  assert.equal(unused?.sources.includes("feedback") ?? false, false);
});
