import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createContext, createPiHarness, writeModule, writeRuntimeStubs } from "./helpers/guard-harness.mjs";
import { activeSessionTask, workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { RECOVERY_CEILINGS } from "../packages/piagent-core/extensions/recovery-decision-validation.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const safeSource = fs.readFileSync(new URL("./fixtures/temporal-composed-helpers.js", import.meta.url), "utf8");
const staticRejection = 'throw new TypeError("Invalid timestamp");';
const unsafeSource = safeSource.replace(staticRejection, 'throw new TypeError(`Invalid timestamp: ${String(value)}`);');
assert.notEqual(unsafeSource, safeSource);

const prompt = "Fix `isExpired(expiresAt, now)` in `src/expiry.js`. An item is expired when now is equal to or later than its expiry instant. Accept an ISO timestamp string or Date for expiresAt, and a millisecond number or Date for now. Invalid dates must throw TypeError; do not use the machine's current time when an explicit falsey value is provided. Preserve the API and verify the project.";
// Both implementations pass these ordinary, live, directly imported tests.
// A passing verifier must not substitute for missing critical source proof.
const focused = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { isExpired } from "../src/expiry.js";',
  'test("invalid inputs are rejected by the changed entrypoint", () => {',
  '  for (const value of ["January 1, 2026", "2026-02-30T00:00:00Z", new Date(NaN)]) {',
  '    assert.throws(() => isExpired(value, 0), TypeError);',
  '  }',
  '  for (const value of [undefined, null, false, new Date(NaN), Number.NaN, Infinity]) {',
  '    assert.throws(() => isExpired("2026-01-01T00:00:00Z", value), TypeError);',
  '  }',
  '});',
  'test("inclusive expiry, explicit zero, precision and Date stability", () => {',
  '  const instant = Date.parse("2026-01-01T00:00:00Z");',
  '  assert.equal(isExpired("2026-01-01T00:00:00Z", instant - 1), false);',
  '  assert.equal(isExpired("2026-01-01T00:00:00Z", instant), true);',
  '  assert.equal(isExpired("2026-01-01T00:00:00Z", instant + 1), true);',
  '  assert.equal(isExpired("2026-01-01T00:00:00Z", 0), false);',
  '  assert.equal(isExpired(new Date(0), 0), true);',
  '  assert.equal(isExpired("9999-01-01T00:00:00Z"), false);',
  '  for (const iso of ["0000-02-29T00:00Z", "0099-12-31T23:59:59.999Z", "2026-01-01T00:00:00.999999999999999999Z", "2026-01-01T00:00:00+07:00", "2026-01-01T00:00:00-00:30"]) {',
  '    const timestamp = Date.parse(iso);',
  '    assert.equal(isExpired(iso, timestamp - 1), false);',
  '    assert.equal(isExpired(iso, timestamp), true);',
  '    assert.equal(isExpired(iso, timestamp + 1), true);',
  '  }',
  '  const expiry = new Date(instant), now = new Date(instant);',
  '  assert.equal(isExpired(expiry, now), true);',
  '  assert.equal(expiry.getTime(), instant);',
  '  assert.equal(now.getTime(), instant);',
  '});',
  ''
].join("\n");

async function guardFixture(context, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-composed-helper-guard-"));
  context.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("pi-composed-helper-guard-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeRuntimeStubs(root);
  for (const relative of ["packages/piagent-core", "adapters", "packs", "evals", "scripts"]) {
    fs.cpSync(path.join(repoRoot, relative), path.join(root, relative), { recursive: true });
  }
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
  const { default: registerGuard } = await import(pathToFileURL(path.join(root, "packages/piagent-core/extensions/piagent-guard.ts")).href);
  const cwd = path.join(root, "project");
  writeModule(path.join(cwd, "src/expiry.js"), "export function isExpired(expiresAt, now) { return false; }\n");
  writeModule(path.join(cwd, "test/expiry.test.js"), "// baseline\n");
  writeModule(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/expiry.test.js" } }));
  const profile = {
    schemaVersion: 1, projectId: `composed-helper-${label}`, displayName: "Composed Helper Guard",
    mode: "node-typescript", protectedPaths: [], shellProtectedPaths: [], requiredContext: [],
    verifyCommands: { test: ["npm test"] }, mcpCapabilities: ["filesystem-readonly", "filesystem-write", "shell"],
    permissionProfile: "workspace-write",
    runtimePolicy: { execPolicy: "enforce", contextBudget: "enforce", toolRegistry: "advisory", finalGate: "enforce" }
  };
  writeModule(path.join(cwd, ".pi/piagent-profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", "src/expiry.js", "test/expiry.test.js", "package.json"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "expiry baseline"]);
  const sessionId = `composed-helper-${label}`;
  const ctx = createContext(cwd, { sessionId, sessionName: sessionId });
  const harness = createPiHarness({ activeTools: ["read", "bash", "edit", "write"] });
  registerGuard(harness.pi);
  await harness.handlers.get("session_start")({}, ctx);
  await harness.handlers.get("input")({ text: prompt, source: "user" }, ctx);
  await harness.handlers.get("before_agent_start")({ prompt, systemPrompt: "stable system prompt" }, ctx);
  const initial = activeSessionTask(cwd, sessionId);
  assert.ok(initial);
  assert.deepEqual(initial.verifyCommands, ["npm test"]);
  return { cwd, ctx, harness, sessionId, initial, profile };
}

// Independent fresh tasks: an unknown-proof handoff is not permission to
// mutate its source. Neither case changes the profile, ceilings or intake.
for (const correct of [false, true]) {
  const label = correct ? "static-safe" : "dynamic-coercion";
  test(`registered completion guard handles ${label} without expanded authority`, async (context) => {
    assert.deepEqual(RECOVERY_CEILINGS, { sourceRepairPasses: 1, transientVerifierRetries: 1, unknownDiagnosticPasses: 1, providerRetries: 1 });
    const { cwd, ctx, harness, sessionId, initial, profile } = await guardFixture(context, label);
    const source = correct ? safeSource : unsafeSource;
    let sequence = 0;
    const authorize = async (toolName, input) => {
      const toolCallId = `${label}-${++sequence}`;
      const result = await harness.handlers.get("tool_call")({ toolCallId, toolName, input }, ctx) ?? {};
      assert.equal(result.block, undefined, result.reason);
      return toolCallId;
    };
    const finish = (toolCallId, toolName, input, output) => harness.handlers.get("tool_result")({
      toolCallId, toolName, input, content: [{ type: "text", text: output }],
      details: { exitCode: 0 }, isError: false, timestamp: Date.now()
    }, ctx);
    const read = { path: "src/expiry.js" };
    await finish(await authorize("read", read), "read", read, fs.readFileSync(path.join(cwd, read.path), "utf8"));
    for (const input of [{ path: "src/expiry.js", content: source }, { path: "test/expiry.test.js", content: focused }]) {
      const id = await authorize("write", input);
      fs.writeFileSync(path.join(cwd, input.path), input.content);
      await finish(id, "write", input, `Wrote ${input.path}`);
    }

    const verifier = { command: "npm test" };
    const verifyId = await authorize("bash", verifier);
    const projectEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
    delete projectEnv.NODE_TEST_CONTEXT;
    const output = execFileSync("npm", ["test"], { cwd, env: projectEnv, encoding: "utf8", timeout: 30_000 });
    assert.match(output, /# tests 2\b/);
    assert.match(output, /# fail 0\b/);
    assert.match(output, /# skipped 0\b/);
    await finish(verifyId, "bash", verifier, output);
    const review = { command: "git diff --no-ext-diff HEAD -- src/expiry.js test/expiry.test.js && git status --short" };
    await finish(await authorize("bash", review), "bash", review, execFileSync("sh", ["-c", review.command], { cwd, encoding: "utf8" }));
    const claim = await harness.handlers.get("message_end")({
      message: { role: "assistant", content: [{ type: "text", text: "The expiry implementation, focused tests and current-tree review are complete." }] }
    }, ctx);
    const task = activeSessionTask(cwd, sessionId);
    const criterion = task.acceptanceReceipt.criteria.find((item) => item.obligation === "invalid-input-rejection");
    assert.ok(criterion);
    assert.equal(criterion.priority, "critical");
    const verified = task.verifyEvidence.at(-1);
    assert.equal(verified.command, "npm test");
    assert.equal(verified.exitCode, 0);
    assert.equal(verified.observed, true);
    assert.equal(verified.matchedProfileCommand, true);
    assert.equal(verified.preWorkingTreeDigest, verified.workingTreeDigest);
    assert.equal(verified.preWorkspaceRevisionDigest, verified.workspaceRevisionDigest);
    assert.ok(verified.workspaceRevisionDigest);
    assert.equal(verified.workingTreeDigest, workingTreeEvidenceDigest(workingTreeSnapshot(cwd)));
    assert.equal(workingTreeEvidenceDigest(task.finalFileDigests), verified.workingTreeDigest);
    assert.equal(fs.readFileSync(path.join(cwd, "src/expiry.js"), "utf8"), source);
    assert.deepEqual(task.authoritySnapshot, initial.authoritySnapshot);
    assert.equal(task.attempt, initial.attempt);
    assert.equal(task.maxAttempts, initial.maxAttempts);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/piagent-profile.json"), "utf8")), profile);
    const recoveries = harness.entries.filter((entry) => entry.payload?.customType === "piagent-completion-recovery");
    if (correct) {
      assert.equal(claim, undefined, JSON.stringify({ claim, recoveries, workPlan: task.workPlan }));
      assert.equal(criterion.status, "satisfied");
      assert.equal(task.trace.outcome, "completed");
      assert.equal(recoveries.length, 0);
    } else {
      assert.match(claim.message.content[0].text, /CONTINUING/);
      assert.equal(task.trace.outcome, "pending");
      assert.equal(criterion.status, "pending");
      assert.equal(recoveries.length, 1);
      const recovery = recoveries[0].payload;
      assert.equal(recovery.details.recovery.failureCategory, "unknown");
      assert.equal(recovery.details.recovery.sourceMutationAllowed, false);
      assert.equal(recovery.details.recovery.counts.sourceRepairPasses, 0);
      assert.deepEqual(recovery.details.recovery.ceilings, RECOVERY_CEILINGS);
      assert.match(recovery.content, /invalid Date.*toString.*Symbol\.toPrimitive.*RangeError/);
      assert.match(recovery.content, /repair only after reproducing the counterexample/);
      assert.match(recovery.content, /missing verification evidence, not an observed implementation defect/);
      const handoff = JSON.parse(fs.readFileSync(path.join(cwd, ".pi/piagent-state/handoffs", `${task.taskRunId}.json`), "utf8"));
      assert.equal(handoff.state.completionApproved, false);
      assert.equal(handoff.tree.evidenceCurrent, true);
      assert.equal(handoff.tree.latestVerifierMatchesCurrentTree, true);
      assert.equal(handoff.nextSafeAction.sourceMutationAllowed, false);
    }
  });
}
