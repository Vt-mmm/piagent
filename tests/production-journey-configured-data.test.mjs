import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { loadProductionPublicWitnesses } from "./helpers/production-schedule-witnesses.mjs";
import { dataCoveredContracts } from "./helpers/data-public-coverage.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { benchmarkVerificationReceiptForTurn } from "../scripts/benchmark-independent-verification.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { writeHostContractApproval, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { timeout: 300000, skip: !imageId || !dockerSocket
  ? "requires explicitly pinned local worker; missing execution is not configured-treatment qualification" : false };

// A-v2 treatment evidence, separate from release-defaults. Existing default
// correct-completion expectations are retained. Public host-owned contracts
// run against current source; the model cannot supply expectations or approval.
const scenarios = [
  { id: "quoted-csv", mutate: source => source.replace(" || text.endsWith('\"')", ""),
    smoke: "import {parseCsv} from '../src/data/csv.js';test('smoke',()=>assert.deepEqual(parseCsv('a,b'),[['a','b']]));",
    witness: "empty-quoted-final" },
  { id: "stable-dedup", mutate: source => source.replace("Number(event.sequence) >= Number(current.sequence)", "Number(event.sequence) > Number(current.sequence)"),
    smoke: "import {deduplicateEvents} from '../src/data/dedup.js';test('smoke',()=>assert.deepEqual(deduplicateEvents([]),[]));",
    witness: "equal-later" }
];
for (const scenario of scenarios) for (const variant of ["correct", "wrong-with-passing-project-checks", "unsupported-import"]) {
  test(`configured data journey ${scenario.id}: ${variant}`, integration, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-configured-workflow-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, scenario.id);
    assert.deepEqual(prepared.turns.map(turn => turn.id), ["scout", "implement", "verify"]);
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json")))).profile;
    const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
    const preview = benchmarkVerificationReceiptForTurn(prepared.turns[1], { profile, policy });
    const contracts = dataCoveredContracts(scenario.id, preview.criteria);
    const reviewPreview = benchmarkVerificationReceiptForTurn(prepared.turns[2], { profile, policy });
    assert.equal(reviewPreview.criteria[0].criterionText,
      "Verify the implementation against every obligation from the earlier request.");
    // This explicitly approved follow-up rechecks the union of the same public
    // clause-covered histories on current source. Project verification, focused
    // tests and diff inspection remain separate native completion gates.
    const reviewCases = new Map();
    for (const contract of contracts) for (const check of contract.checks) for (const item of check.cases) {
      if (reviewCases.has(item.id)) assert.deepEqual(reviewCases.get(item.id), item);
      reviewCases.set(item.id, structuredClone(item));
    }
    const reviewContract = { ...contracts[0], criterionId: reviewPreview.criteria[0].criterionId,
      criterionHash: reviewPreview.criteria[0].criterionHash,
      checks: [{ id: "workflow-review-original-obligations", cases: [...reviewCases.values()] }] };
    const backend = { imageId, dockerSocket, timeoutMs: 10000, profile: expectedNodeProfile() };
    const authorityParent = path.join(root, "private-fixture-authority"); fs.mkdirSync(authorityParent, { mode: 0o700 });
    const approval = writeHostContractApproval({ directory: path.join(authorityParent, "workflow"),
      projectRoot: prepared.workspace, installedRoot: repositoryRoot, approved: true,
      plans: prepared.turns.map((turn, index) => ({ schemaVersion: 3,
        operatorRequestDigest: operatorRequestDigest(benchmarkVerificationReceiptForTurn(turn, { profile, policy }).query),
        backend, contracts: index === 0 ? []
          : index === 1 ? contracts : [reviewContract],
        ...(index === 0 ? { nativeOnly: true } : {}) })) });
    const [sourcePath, reference] = productionV3ReferenceSolution(prepared.scenario.id);
    const source = variant === "wrong-with-passing-project-checks"
      ? scenario.mutate(reference)
      : variant === "unsupported-import" ? 'import "node:fs";\n' + reference : reference;
    if (["wrong-with-passing-project-checks", "unsupported-import"].includes(variant)) assert.notEqual(source, reference);
    const testPath = "test/configured-workflow-public.test.js";
    const publicTests = variant === "wrong-with-passing-project-checks"
      ? "import assert from 'node:assert/strict';import test from 'node:test';" + scenario.smoke + "\n"
      : loadProductionPublicWitnesses(repositoryRoot).get(prepared.scenario.id).tests;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length);
    const scripts = [
      [scriptedTool("configured-scout-source", "read", { path: sourcePath }),
        scriptedTool("configured-scout-package", "read", { path: "package.json" }),
        scriptedText("Reviewed the current data implementation and public project commands. The requested parsing or ordering behavior needs the focused change and executable verification described in the request. Preserve the API and inputs. No files were changed.")],
      [scriptedTool("configured-implement-read", "read", { path: sourcePath }),
        scriptedTool("configured-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("configured-write-tests", "write", { path: testPath, content: publicTests }),
        ...commands.map((command, index) => scriptedTool(`configured-implement-verify-${index}`, "bash", { command })),
        scriptedText("Implemented the requested source change and ran the project checks. The requested task is complete.")],
      [scriptedTool("configured-review-source", "read", { path: sourcePath }),
        scriptedTool("configured-review-tests", "read", { path: testPath }),
        scriptedTool("configured-review-focused", "bash", { command: `node --test ${testPath}` }),
        ...commands.map((command, index) => scriptedTool(`configured-review-verify-${index}`, "bash", { command })),
        scriptedTool("configured-review-diff", "bash", { command: `git diff --no-ext-diff -- ${sourcePath} ${testPath}` }),
        scriptedText(`Reviewed the final diff and current source. Focused node --test ${testPath} and configured checks ${commands.join("; ")} passed. The requested work is complete.`)]
    ];
    await withJourneyEnvironment({ ...prepared.environment, PIAGENT_INDEPENDENT_VERIFICATION_CONFIG: approval.configPath }, async () => {
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir,
        repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const result = await runtime.turn(turn, scripts[index], 120000); results.push(result);
          t.diagnostic(JSON.stringify({ scenario: scenario.id, variant, treatment: "configured-host-verification-a-v2", turn: turn.id,
            promptSha256: sha(turn.message), taskOutcome: result.task?.trace.outcome,
            taskRunId: result.task?.taskRunId, operatorRequestDigest: result.task?.operatorRequestDigest,
            criteria: result.task?.acceptanceReceipt?.criteria.map(item => ({ id: item.id, status: item.status })),
            operationStatus: result.settlement.settlement, modelMessages: result.scriptedTurns,
            mutationPolicy: result.task?.mutationPolicy, changeMode: result.task?.changeMode, gate: result.task?.lastCompletionGate,
            unconsumedScript: result.unconsumedScript }));
        }
        const [scout, implemented, reviewed] = results;
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0); assert.ok(runtime.metrics.unexpectedTurns <= 1);
        assert.equal(runtime.transport.snapshot().commandDispatches, 3);
        assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
        assert.equal(scout.task.trace.outcome, "completed");
        assert.equal(implemented.task.operatorRequestDigest, operatorRequestDigest(preview.query));
        const verification = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
          && /^configured-(?:implement|review)-verify-/.test(event.toolCallId));
        assert.equal(verification.length, commands.length * 2);
        assert.ok(verification.every(event => event.isError === false), "project checks really pass, even for the deliberate weak-test mutant");
        const configuration = openHostContractConfiguration({ configPath: approval.configPath,
          projectRoot: prepared.workspace, installedRoot: repositoryRoot });
        try {
          assert.equal(configuration.isCurrent(), true);
          const observations = contracts.map(contract => {
            const event = configuration.store.latest({ taskRunId: implemented.task.taskRunId, criterionId: contract.criterionId });
            assert.equal(event?.phase, "settled", "host-owned execution must settle for each covered criterion");
            assert.equal(event.binding.criterionHash, contract.criterionHash);
            assert.equal(event.binding.verifierDigest, approval.verifierDigest);
            const evidence = JSON.parse(event.evidenceText), result = evidence.observed.result;
            const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 2, profile: backend.profile,
              source, exportName: contract.exportName, checks: contract.checks }));
            assert.equal(event.binding.planDigest, compiled.planDigest);
            assert.equal(result.execution.cleanupConfirmed, true);
            const compared = compareIndependentExecution(compiled, result.execution);
            assert.equal(compared.verdict, evidence.verdict);
            return { criterionId: contract.criterionId, verdict: compared.verdict,
              executionStatus: result.execution.status, counterexamples: compared.counterexamples.map(item => item.evidence.input.id) };
          });
          t.diagnostic(JSON.stringify({ variant, actualAuthenticatedObservations: observations, imageId,
            profileDigest: backend.profile.digest, verifierDigest: approval.verifierDigest, productionAuthority: false }));
          if (variant === "correct") {
            assert.ok(observations.every(item => item.verdict === "pass"));
            assert.equal(reviewed.task.operatorRequestDigest, operatorRequestDigest(reviewPreview.query));
            const reviewEvent = configuration.store.latest({ taskRunId: reviewed.task.taskRunId,
              criterionId: reviewContract.criterionId });
            assert.equal(reviewEvent?.phase, "settled");
            assert.equal(reviewEvent.binding.criterionHash, reviewContract.criterionHash);
            const reviewEvidence = JSON.parse(reviewEvent.evidenceText);
            const compiledReview = compileIndependentContract(JSON.stringify({ schemaVersion: 2, profile: backend.profile,
              source, exportName: reviewContract.exportName, checks: reviewContract.checks }));
            assert.equal(reviewEvent.binding.planDigest, compiledReview.planDigest);
            assert.equal(reviewEvidence.observed.result.execution.cleanupConfirmed, true);
            assert.equal(compareIndependentExecution(compiledReview, reviewEvidence.observed.result.execution).verdict, "pass");
            t.diagnostic(JSON.stringify({ variant, reviewCurrentSourceRechecked: true,
              authoredCaseCount: reviewCases.size, planDigest: compiledReview.planDigest,
              actualVerdict: reviewEvidence.verdict, cleanupConfirmed: true }));
          }
          else if (variant === "wrong-with-passing-project-checks") assert.ok(observations.some(item => item.verdict === "fail"
            && item.counterexamples.includes(scenario.witness)));
          else assert.ok(observations.every(item => item.verdict !== "pass"));
        } finally { configuration.close(); }
        if (variant === "correct") {
          assert.equal(implemented.task.trace.outcome, "completed");
          assert.equal(reviewed.task.trace.outcome, "completed");
          assert.ok(implemented.task.acceptanceReceipt.criteria.every(item => item.status === "satisfied"));
        } else {
          assert.notEqual(implemented.task.trace.outcome, "completed"); assert.notEqual(reviewed.task.trace.outcome, "completed");
          const handoff = JSON.parse(fs.readFileSync(path.join(prepared.workspace,
            ".pi/piagent-state/handoffs", `${reviewed.task.taskRunId}.json`)));
          assert.equal(handoff.state.completionApproved, false); assert.equal(handoff.nextSafeAction.action, "handoff");
        }
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
      } finally { await runtime.close(); }
    });
  });
}
