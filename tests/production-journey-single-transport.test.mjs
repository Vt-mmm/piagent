import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const textContent = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
// Witnesses are authored from the unchanged public requests, not private oracle
// or registered recipe data. They run as real project tests, not fabricated proof.
const cases = [
  { id: "unicode-search", profile: "web-frontend", lifecycle: "cold-start", mutant: "case-sensitive",
    mutate: source => source.replace(".toLowerCase()", ""),
    publicTests: `import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSearchText, includesSearchText } from '../src/frontend/unicode-search.js';
test('case-insensitive search preserves both exports', () => {
  assert.equal(normalizeSearchText('CAFE'), 'cafe');
  assert.equal(includesSearchText('prefix CAFÉ suffix', 'cafe'), true);
  assert.equal(includesSearchText('prefix café suffix', 'MISSING'), false);
});
test('decomposable accents and whitespace normalize consistently', () => {
  assert.equal(normalizeSearchText('  Résumé \\t café\\n menu  '), 'resume cafe menu');
  assert.equal(normalizeSearchText('re\\u0301sume\\u0301'), 'resume');
  assert.equal(includesSearchText('  À LA\\tCARTE  ', 'a la carte'), true);
});
test('nullish inputs do not throw', () => {
  assert.doesNotThrow(() => normalizeSearchText(null));
  assert.doesNotThrow(() => normalizeSearchText(undefined));
  assert.doesNotThrow(() => includesSearchText(null, undefined));
  assert.doesNotThrow(() => includesSearchText(undefined, null));
});
` },
  { id: "cli-double-dash", profile: "fullstack", lifecycle: "steady-state", mutant: "flags-after-terminator",
    mutate: source => source.replace("parsing = false; continue;", "continue;"),
    publicTests: `import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../src/platform/args.js';
test('both value syntaxes, adjacent boolean flags and repeated last value', () => {
  assert.deepEqual(parseArgs(['--name', 'first', '--enabled', '--verbose', '--name=last', 'tail']),
    { flags: { name: 'last', enabled: true, verbose: true }, positional: ['tail'] });
  assert.deepEqual(parseArgs(['--empty=']), { flags: { empty: '' }, positional: [] });
  assert.deepEqual(parseArgs(['--name=value=rest']), { flags: { name: 'value=rest' }, positional: [] });
});
test('first standalone terminator makes every later token positional', () => {
  assert.deepEqual(parseArgs(['--mode=one', '--', '--mode=two', '--flag', 'tail', '--']),
    { flags: { mode: 'one' }, positional: ['--mode=two', '--flag', 'tail', '--'] });
  assert.deepEqual(parseArgs(['--', '--flag']), { flags: {}, positional: ['--flag'] });
  assert.deepEqual(parseArgs(['--flag', '--', '--name=x']), { flags: { flag: true }, positional: ['--name=x'] });
});
test('input argv remains unchanged and empty input preserves result shape', () => {
  const argv = ['--a', 'one', '--', '--b']; const before = [...argv];
  assert.deepEqual(parseArgs(argv), { flags: { a: 'one' }, positional: ['--b'] });
  assert.deepEqual(argv, before);
  assert.deepEqual(parseArgs([]), { flags: {}, positional: [] });
});
` }
];

for (const specification of cases) for (const variant of ["reference", specification.mutant]) {
  test(`actual default single-turn HTTP/WebSocket journey: ${specification.id}/${variant}`, { timeout: 120000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-single-wire-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, specification.id);
    assert.equal(prepared.scenario.profile, specification.profile);
    assert.equal(prepared.scenario.lifecycle, specification.lifecycle);
    assert.deepEqual(prepared.turns.map(turn => turn.id), ["request"]);
    const turn = prepared.turns[0];
    assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, prepared.scenario.userJourney.turns[0].prompt), "utf8").trim());
    assert.equal(Object.hasOwn(turn, "workflow"), false);
    const [sourcePath, reference] = productionV3ReferenceSolution(specification.id);
    const source = variant === "reference" ? reference : specification.mutate(reference);
    if (variant !== "reference") assert.notEqual(source, reference);
    const testPath = "test/declared-contract-public.test.js";
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
        agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const script = [scriptedTool("single-read", "read", { path: sourcePath }),
          scriptedTool("single-source", "write", { path: sourcePath, content: source }),
          scriptedTool("single-tests", "write", { path: testPath, content: specification.publicTests }),
          ...commands.map((command, index) => scriptedTool(`single-verify-${index}`, "bash", { command })),
          scriptedText(variant === "reference" ? "Implemented the requested behavior and ran the configured project verification. The work is ready for review."
            : "Configured verification failed on the requested behavior. The task remains incomplete; no successful completion is claimed.")];
        const result = await runtime.turn(turn, script);
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end" && /^single-verify-/.test(event.toolCallId));
        const snapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
        const currentVerification = Boolean(result.task && allConfiguredVerifierEvidenceCurrent(result.task, snapshot.digest, snapshot.workspaceRevisionDigest));
        t.diagnostic(JSON.stringify({ stage: "default-journey-coverage", scenario: specification.id, variant, turn: turn.id,
          promptSha256: sha(turn.message), sourceSha256: sha(source), testSha256: sha(specification.publicTests),
          settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
          task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId, outcome: result.task.trace.outcome,
            verifyCommands: result.task.verifyCommands, verifyEvidence: result.task.verifyEvidence,
            acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
          verifications: verifications.map(event => ({ id: event.toolCallId, isError: event.isError, output: textContent(event.result?.content) })),
          currentVerification, scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript,
          metrics: runtime.metrics, extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0); assert.equal(result.unconsumedScript, 0);
        assert.ok(runtime.metrics.unexpectedTurns <= 1);
        assert.equal(result.command.payload.message, turn.message);
        assert.deepEqual(result.wireSettlement.payload, result.settlement);
        assert.equal(result.settlement.sessionRef, result.receipt.sessionRef);
        assert.equal(result.settlement.operationRef, result.receipt.operationRef);
        assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
        assert.equal(result.transport.connections, 1); assert.equal(result.transport.commandDispatches, 1);
        assert.equal(result.transport.unauthenticatedCatalogStatus, 401);
        assert.equal(verifications.length, commands.length);
        for (const event of verifications) {
          const output = textContent(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively|reused exact verifier evidence/);
          assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
          assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), specification.publicTests);
        if (variant === "reference") {
          assert.ok(verifications.every(event => event.isError === false), "reference must pass actual configured verification");
          assert.equal(currentVerification, true);
          assert.equal(result.task.trace.outcome, "completed", "a correct sufficiently evidenced default task must complete");
          assert.equal(result.settlement.taskStatus, "completed");
          assert.equal(result.settlement.settlement, "completed");
          assert.equal(runtime.metrics.unexpectedTurns, 0);
        } else {
          const failed = verifications.filter(event => event.isError === true);
          assert.ok(failed.length, "wrong implementation must fail actual configured verification");
          assert.match(failed.map(event => textContent(event.result?.content)).join("\n"), /ERR_ASSERTION/);
          assert.equal(currentVerification, false);
          assert.notEqual(result.task.trace.outcome, "completed");
          assert.notEqual(result.settlement.taskStatus, "completed");
        }
      } finally { await runtime.close(); }
    });
  });
}

test("actual protected-env refusal completes its declared HTTP/WebSocket turn without tools or disclosure", { timeout: 120000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-env-refusal-wire-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "protected-env-refusal");
  assert.deepEqual(prepared.turns.map(turn => turn.id), ["request"]);
  const turn = prepared.turns[0];
  assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, prepared.scenario.userJourney.turns[0].prompt), "utf8").trim());
  const status = () => execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: prepared.workspace, encoding: "utf8" });
  const before = status();
  await withJourneyEnvironment(prepared.environment, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
      agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
    try {
      const refusal = "REFUSAL=protected-env-read\nSAFE_ALTERNATIVE=redacted-variable-names";
      const result = await runtime.turn(turn, [scriptedText(refusal)]);
      t.diagnostic(JSON.stringify({ stage: "default-journey-coverage", scenario: "protected-env-refusal", variant: "correct-refusal", turn: turn.id,
        promptSha256: sha(turn.message), settlement: result.settlement, wireSettlement: result.wireSettlement,
        task: { taskRunId: result.task?.taskRunId, sessionId: result.sessionId, outcome: result.task?.trace.outcome,
          terminalDisposition: result.task?.trace.terminalDisposition }, transport: result.transport,
        scriptedTurns: result.scriptedTurns, unconsumedScript: result.unconsumedScript, metrics: runtime.metrics }));
      assert.equal(result.command.payload.message, turn.message);
      assert.deepEqual(result.wireSettlement.payload, result.settlement);
      assert.equal(result.settlement.sessionRef, result.receipt.sessionRef);
      assert.equal(result.settlement.operationRef, result.receipt.operationRef);
      assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
      assert.equal(result.settlement.settlement, "completed");
      assert.equal(result.settlement.taskStatus, "refused");
      assert.equal(result.task.trace.terminalDisposition, "refused");
      assert.equal(result.task.trace.outcome, "blocked");
      assert.equal(result.unconsumedScript, 0);
      assert.equal(result.transport.connections, 1); assert.equal(result.transport.commandDispatches, 1);
      assert.equal(result.transport.unauthenticatedCatalogStatus, 401);
      assert.deepEqual(runtime.metrics, { scriptedTurns: 1, unexpectedTurns: 0, realProviderCalls: 0 });
      assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
      assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start").length, 0);
      const answers = runtime.rawEvents.filter(event => event.type === "message_end" && event.message?.role === "assistant")
        .map(event => textContent(event.message.content));
      assert.deepEqual(answers, [refusal]);
      assert.equal(status(), before);
    } finally { await runtime.close(); }
  });
});
