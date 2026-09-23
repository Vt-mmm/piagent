import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { benchmarkVerificationReceiptForTurn } from "../scripts/benchmark-independent-verification.mjs";
import { activeSessionTask, operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { createScopedBrokerPiOperationRouter } from "../scripts/benchmark-scoped-pi-router.mjs";
import { createScopedMaterialBroker } from "../scripts/benchmark-scoped-tool-broker.mjs";
import { scopedProjectVerificationPlanBinding, createScopedProjectVerificationSupervisor } from "../scripts/benchmark-scoped-project-verifier.mjs";
import { scopedQualificationIdentity, scopedToolDefinitionsSha256, scopedJournalPathSha256, scopedVerificationReceiptKeyDigest } from "../scripts/benchmark-scoped-verification-supervisor.mjs";
import { scopedBrokerProfileDigest, scopedBrokerArmDigest } from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
import { SCOPED_DOCS_POLICY, DOCS_COMMANDS } from "../scripts/benchmark-scoped-docs-verifier.mjs";

import { independentAcceptanceState } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureCompositeExecutionSnapshot } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { openScopedMediationEvidence, scopedMediationFactObservation } from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { timeout: 300000, skip: !imageId || !dockerSocket
  ? "requires explicitly pinned local worker; missing execution is not configured-treatment qualification" : false };
function installedToolchain() {
  const resolve = command => fs.realpathSync(execFileSync("/bin/sh", ["-c", 'command -v "$1"', "resolve-tool", command], { encoding: "utf8" }).trim());
  const npm = resolve("npm");
  return { gitCommand: resolve("git"), shellCommand: "/bin/sh", npmRoot: path.dirname(path.dirname(npm)) };
}

for (const variant of ["correct", "missing-restart"]) test(`configured documentation through actual SDK and scoped tools: ${variant}`, integration, async t => {
  const toolchain = installedToolchain();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcl-docs-sdk-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, "repository-prompt-injection");
  fs.chmodSync(prepared.workspace, 0o700);
  const profile = resolveProjectProfileDocument(repositoryRoot, JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json")))).profile;
  const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
  const turn = prepared.turns[1], preview = benchmarkVerificationReceiptForTurn(turn, { profile, policy });
  const scout = prepared.turns[0], scoutPreview = benchmarkVerificationReceiptForTurn(scout, { profile, policy });
  const review = prepared.turns[2], reviewPreview = benchmarkVerificationReceiptForTurn(review, { profile, policy });
  const configBytes = fs.readFileSync(path.join(prepared.workspace, "config/service.json")), config = JSON.parse(configBytes);
  const initialDocument = fs.readFileSync(path.join(prepared.workspace, "docs/ops.md"));
  const document = `# Operations\n\nService: ${config.service}\nRestart command: ${variant === "correct" ? config.restartCommand : "unavailable"}\n`;
  const files = dir => fs.readdirSync(path.join(prepared.workspace, dir), { recursive: true }).filter(name => name.endsWith(".js")).map(name => `${dir}/${name}`).sort();
  const docsPolicy = { version: SCOPED_DOCS_POLICY, configuredCommands: [...DOCS_COMMANDS], currentFiles: ["docs/ops.md"],
    frozenPolicy: { version: "scoped-project-verifier-policy-v1", configuredScripts: { "type-check": "node scripts/check.mjs", lint: "node scripts/check.mjs", test: "node --test test/*.test.js", "test:e2e": "node --test test/*.test.js" }, configurationFiles: ["package.json", "scripts/check.mjs"], syntaxFiles: [...files("src"), ...files("test")].sort(), testFiles: files("test") }, toolchain };
  const verificationBinding = scopedProjectVerificationPlanBinding({ projectRoot: prepared.workspace, nodeCommand: process.execPath, policy: docsPolicy, timeoutMs: 15000 });
  // Test-owned custody fixture follows the existing composite integration test.
  // It is not a release/campaign qualification of the dirty implementation tree.
  const fixtureRoot = path.join(root, "qualification-fixture"), fixtureAssets = path.join(fixtureRoot, "packages/piagent-webui/dist/client");
  fs.mkdirSync(fixtureAssets, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "source.mjs"), `export const frozenCandidate = "${sha(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/runtime/verification/composite-scoped-mediation.ts")))}";\n`);
  fs.writeFileSync(path.join(fixtureAssets, "index.html"), "offline custody fixture\n");
  execFileSync("git", ["-C", fixtureRoot, "init", "-q"]); execFileSync("git", ["-C", fixtureRoot, "add", "."]);
  execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test-owned custody fixture"]);
  const qualificationRoots = { candidateRoot: fs.realpathSync(fixtureRoot), assetsRoot: fs.realpathSync(fixtureAssets), sdkRoot: fs.realpathSync("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent") };
  const qualification = scopedQualificationIdentity(qualificationRoots);
  const manifestKey = generateKeyPairSync("ed25519"), journalKey = generateKeyPairSync("ed25519"), receiptKey = generateKeyPairSync("ed25519");
  const brokerRoot = path.join(root, "broker"), stagingRoot = path.join(root, "staging");
  fs.mkdirSync(brokerRoot, { mode: 0o700 }); fs.mkdirSync(stagingRoot, { mode: 0o700 });
  const configDigest = sha("offline configured documentation integration");
  const identityBase = { version: 3, armId: "candidate", sourceSha256: qualification.sourceSha256, assetTreeSha256: qualification.assetTreeSha256,
    configSha256: configDigest, brokerClosureSha256: qualification.brokerClosureSha256, toolDefinitionsSha256: scopedToolDefinitionsSha256(),
    manifestAuthoritySha256: scopedVerificationReceiptKeyDigest(manifestKey.publicKey), journalSignerSha256: scopedVerificationReceiptKeyDigest(journalKey.publicKey),
    contextPolicySha256: sha("PCL explicit docs materials and signed-only commands"), sdkTreeSha256: qualification.sdkTreeSha256 };
  const producer = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "adapters/common/assurance-producers.json"))).producers[0];
  const documentRule = producer.rules.find(rule => rule.id === "config-literals-v1");
  const hostProducer = { id: "native-host-facts-v1", digest: sha("native-host-facts-v1") };
  const fact = (id, kind, parameters, stage = "content") => ({ id, kind, parameters, stage,
    producerId: hostProducer.id, producerDigest: hostProducer.digest, specDigest: sha(`pcl-docs:${kind}`), ruleDigest: sha(`pcl-docs-rule:${kind}`) });
  const facts = [
    { ...fact("document", "config-document-literals", { configMaterialId: "config", documentMaterialId: "document", format: "config-literals-v1", requiredFields: ["service", "restartCommand"] }), producerId: producer.id, producerDigest: producer.digest, ruleDigest: documentRule.ruleDigest },
    fact("context", "context-current", { requiredMaterialIds: ["config", "document"], delivery: "actual-tool-result-or-prompt" }),
    fact("scope", "workspace-scope", { allowedWriteMaterialIds: ["document"], requireCompleteMutationJournal: true }),
    fact("policy", "tool-policy-complete", { profileDigest: scopedBrokerProfileDigest("document"), requireExclusiveMediation: true }),
    fact("verifier", "project-verifier-current", { commandSetDigest: verificationBinding.planDigest }),
    fact("persisted", "response-persisted", { expectedOrigins: ["assistant"], requireExactBytes: true }, "settlement"),
    fact("delivered", "terminal-delivery", { boundary: "webui-operation-confirmed", requireExactOperation: true }, "settlement")
  ];
  const makeContracts = targetPreview => {
  const declarations = { criteria: targetPreview.criteria.map(c => ({ id: c.criterionId, text: c.criterionText, hash: c.criterionHash })), changeMode: "source-change", requiresOutput: true,
    producers: [{ id: producer.id, digest: producer.digest, kinds: ["config-document-literals"], ruleDigests: [documentRule.ruleDigest] },
      { ...hostProducer, kinds: facts.slice(1).map(f => f.kind), ruleDigests: facts.slice(1).map(f => f.ruleDigest) }],
    factSpecifications: facts.map(({ id, ...f }) => f), codePlans: [], materials: [{ id: "config", byteLength: configBytes.length }, { id: "document", byteLength: 65536 }], authoredCaseCount: 0 };
  return targetPreview.criteria.map((criterion, criterionIndex) => {
    const contract = { route: "composite", compositeContractVersion: "composite-criterion-v1", criterionIndex, ...criterion, facts,
      coverage: [{ id: "whole", startByte: 0, endByte: Buffer.byteLength(criterion.criterionText), textHash: criterion.criterionHash,
        roles: ["document-literals", "read-context", "verification", "persistence", "delivery"], requiredFactIds: facts.map(f => f.id) }] };
    return { route: "composite", criterionId: criterion.criterionId, criterionHash: criterion.criterionHash, maxAttempts: 1,
      planContext: { version: "composite-plan-context-v1", contractText: JSON.stringify(contract), declarationsText: JSON.stringify(declarations),
        identity: { suiteDigest: sha(fs.readFileSync(path.join(prepared.suiteRoot, "suite.json"))), configDigest, armDigest: scopedBrokerArmDigest(identityBase) },
        materialBindings: [{ id: "config", mode: "frozen", relativePath: "config/service.json", sha256: sha(configBytes) }, { id: "document", mode: "current", relativePath: "docs/ops.md", sha256: null }] } };
  });
  };
  const contracts = makeContracts(preview), reviewContracts = makeContracts(reviewPreview);
  const backend = { imageId, dockerSocket, timeoutMs: 10000, profile: expectedNodeProfile() };
  const approval = writeHostContractApproval({ directory: path.join(root, "authority"), projectRoot: prepared.workspace, installedRoot: repositoryRoot, approved: true,
    plans: [{ schemaVersion: 3, nativeOnly: true, operatorRequestDigest: operatorRequestDigest(scoutPreview.query), backend, contracts: [] },
      { schemaVersion: 3, operatorRequestDigest: operatorRequestDigest(preview.query), backend, contracts },
      { schemaVersion: 3, operatorRequestDigest: operatorRequestDigest(reviewPreview.query), backend, contracts: reviewContracts }] });
  let settledEvidence;
  const router = createScopedBrokerPiOperationRouter({ open(reservation) {
    const task = activeSessionTask(prepared.workspace, reservation.sessionId);
    assert.ok(task); assert.ok([operatorRequestDigest(scoutPreview.query), operatorRequestDigest(preview.query), operatorRequestDigest(reviewPreview.query)].includes(task.operatorRequestDigest));
    const currentDocument = fs.readFileSync(path.join(prepared.workspace, "docs/ops.md"));
    const isScout = task.operatorRequestDigest === operatorRequestDigest(scoutPreview.query);
    const journalPath = path.join(brokerRoot, `${reservation.operationRef}.jsonl`);
    const identity = { ...identityBase, taskId: task.taskId, sessionId: reservation.sessionId, requestId: task.operatorRequestDigest,
      operationId: reservation.operationRef, nonce: reservation.messageRequestId, journalPathSha256: scopedJournalPathSha256(journalPath) };
    const verification = { id: "docs-check", protocol: verificationBinding.protocol, capabilityDigest: verificationBinding.capabilityDigest,
      receiptKeyDigest: scopedVerificationReceiptKeyDigest(receiptKey.publicKey), timeoutMs: 15000 };
    const manifest = { version: 2, identity, profile: "document", root: prepared.workspace,
      materials: [{ id: "config", relativePath: "config/service.json", sha256: sha(configBytes), bytes: configBytes.length, readable: true, writable: false, protected: false },
        { id: "document", relativePath: "docs/ops.md", sha256: sha(currentDocument), bytes: currentDocument.length, readable: true, writable: !isScout, protected: false }], verifications: [verification] };
    const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestSignature = sign(null, manifestBytes, manifestKey.privateKey);
    const bridge = createScopedProjectVerificationSupervisor({ manifestSha256: sha(manifestBytes), brokerIdentitySha256: sha(JSON.stringify(identity)), brokerSourceSha256: identity.brokerClosureSha256,
      receiptPrivateKey: receiptKey.privateKey, verifications: [{ manifest: verification, plan: { projectRoot: prepared.workspace, nodeCommand: process.execPath, stagingRoot, policy: docsPolicy, expectedPlanDigest: verificationBinding.planDigest } }] });
    const broker = createScopedMaterialBroker({ manifestBytes, manifestSignature, manifestPublicKey: manifestKey.publicKey, expectedIdentity: identity, actualConfigSha256: configDigest,
      actualQualification: { version: 3, ...qualificationRoots, ...qualification }, journalPath, journalPrivateKey: journalKey.privateKey, verificationBridge: bridge });
    return { broker, identity, nonce: identity.nonce, settlementEvidence: () => (settledEvidence = { version: "scoped-broker-journal-evidence-v1", manifestBytes, manifestSignature,
      manifestPublicKey: manifestKey.publicKey.export({ type: "spki", format: "pem" }), journalBytes: fs.readFileSync(journalPath), journalPublicKey: broker.journalPublicKey, status: broker.status() }) };
  } });
  await withJourneyEnvironment({ ...prepared.environment, PIAGENT_INDEPENDENT_VERIFICATION_CONFIG: approval.configPath }, async () => {
    const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir, repositoryRoot, transport: "loopback", scopedBrokerRouter: router });
    try {
      const result = await runtime.turn(scout, [
        scriptedTool("config", "scoped_read", { materialId: "config" }),
        scriptedTool("document", "scoped_read", { materialId: "document" }),
        scriptedText("Scouting is complete. Update only docs/ops.md with both values from config/service.json and run git diff --check and the configured project checks. No project files were changed or untrusted instructions followed.")]);
      t.diagnostic(JSON.stringify({ stage: "scout", variant, outcome: result.task?.trace.outcome, gate: result.task?.lastCompletionGate, settlement: result.settlement, independent: independentAcceptanceState(prepared.workspace, result.task, workingTreeEvidenceDigest(workingTreeSnapshot(prepared.workspace))),
        criteria: result.task?.acceptanceReceipt?.criteria.map(c => [c.id, c.status]), toolResults: runtime.rawEvents.filter(e => e.type === "tool_execution_end").map(e => ({ id: e.toolCallId, error: e.isError, outcome: e.result?.details?.outcome, reason: e.result?.details?.reason, materialSha256: e.result?.details?.materialSha256 })),
        extensions: runtime.extensionErrors, services: runtime.serviceErrors, productionAuthority: false, metrics: runtime.metrics }));
      assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []); assert.equal(runtime.metrics.realProviderCalls, 0);
      assert.equal(result.task.changeMode, "read-only");
      assert.equal(result.task.trace.outcome, "completed");
      assert.equal(router.status().consumed, true);
      assert.equal(fs.readFileSync(path.join(prepared.workspace, "docs/ops.md"), "utf8"), initialDocument.toString());
      const implemented = await runtime.turn(turn, [
        scriptedTool("implement-config", "scoped_read", { materialId: "config" }),
        scriptedTool("implement-document", "scoped_read", { materialId: "document" }),
        scriptedTool("implement-write", "scoped_write_document", { materialId: "document", expectedSha256: sha(initialDocument), utf8: document }),
        scriptedTool("implement-current-document", "scoped_read", { materialId: "document" }),
        scriptedTool("implement-verify", "scoped_verify", { verificationId: "docs-check" }),
        scriptedText("The requested documentation work is complete.")], 60000);
      if (variant === "missing-restart") {
        t.diagnostic(JSON.stringify({ stage: "implement", variant, outcome: implemented.task.trace.outcome, settlement: implemented.settlement }));
        assert.notEqual(implemented.task.trace.outcome, "completed");
        assert.equal(implemented.settlement.taskStatus, "pending");
        assert.equal(implemented.settlement.settlement, "blocked");
        assert.match(independentAcceptanceState(prepared.workspace, implemented.task,
          workingTreeEvidenceDigest(workingTreeSnapshot(prepared.workspace))).block, /content counterexample/);
        assert.equal(runtime.metrics.unexpectedTurns, 0); assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.equal(implemented.unconsumedScript, 0); return;
      }
      assert.equal(implemented.task.trace.outcome, "completed");
      assert.equal(implemented.settlement.taskStatus, "completed");
      assert.ok(implemented.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
      {
        const plan = contracts[0].planContext, contract = JSON.parse(plan.contractText);
        const snapshot = captureCompositeExecutionSnapshot({ projectRoot: prepared.workspace,
          materialBindings: plan.materialBindings, declarations: JSON.parse(plan.declarationsText) });
        const expected = { projectRoot: prepared.workspace, task: implemented.task, operationRef: implemented.operationRef,
          messageRequestId: implemented.command.payload.messageRequestId, plan, contract, materials: snapshot.materials };
        assert.ok(openScopedMediationEvidence(settledEvidence, expected));
        // Re-sign test-owned journal copies to isolate ordered content validation
        // from signature validation. The actual broker journal remains untouched.
        for (const [action, materialSha256] of [[2, sha(document)], [4, sha(initialDocument)]]) {
          const rows = settledEvidence.journalBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
          const target = rows.find(row => row.body.type === "result" && row.body.action === action);
          assert.ok(target); target.body.materialSha256 = materialSha256;
          let previous = "0".repeat(64);
          const journalBytes = Buffer.from(rows.map(row => {
            row.body.previous = previous;
            row.signature = sign(null, Buffer.from(JSON.stringify(row.body)), journalKey.privateKey).toString("base64");
            const line = JSON.stringify(row) + "\n"; previous = sha(line); return line;
          }).join(""));
          assert.throws(() => openScopedMediationEvidence({ ...settledEvidence, journalBytes,
            status: { ...settledEvidence.status, journalSha256: sha(journalBytes) } }, expected), /scoped-read-result-mismatch/);
        }

      }
      const reviewed = await runtime.turn(review, [
        scriptedTool("review-config", "scoped_read", { materialId: "config" }),
        scriptedTool("review-document", "scoped_read", { materialId: "document" }),
        scriptedTool("review-verify", "scoped_verify", { verificationId: "docs-check" }),
        scriptedText("Review is complete. Both config values are present verbatim in docs/ops.md. The focused and full configured checks passed; no further change was needed.")], 120000);
      t.diagnostic(JSON.stringify({ review: { outcome: reviewed.task.trace.outcome, settlement: reviewed.settlement,
        gate: reviewed.task.lastCompletionGate, independent: independentAcceptanceState(prepared.workspace, reviewed.task, workingTreeEvidenceDigest(workingTreeSnapshot(prepared.workspace))) } }));
      const reviewPlan = reviewContracts[0].planContext, reviewContract = JSON.parse(reviewPlan.contractText);
      const snapshot = captureCompositeExecutionSnapshot({ projectRoot: prepared.workspace,
        materialBindings: reviewPlan.materialBindings, declarations: JSON.parse(reviewPlan.declarationsText) });
      const expected = { projectRoot: prepared.workspace, task: reviewed.task, operationRef: reviewed.operationRef,
        messageRequestId: reviewed.command.payload.messageRequestId, plan: reviewPlan, contract: reviewContract, materials: snapshot.materials };
      const mediation = openScopedMediationEvidence(settledEvidence, expected);
      const observations = Object.fromEntries(reviewContract.facts.filter(f => ["context-current", "workspace-scope", "tool-policy-complete", "project-verifier-current"].includes(f.kind))
        .map(fact => [fact.kind, scopedMediationFactObservation(mediation, { ...expected, fact, workspace: workingTreeSnapshot(prepared.workspace) })]));
      t.diagnostic(JSON.stringify({ reviewFactObservations: observations, mutationPolicy: reviewed.task.mutationPolicy,
        writes: settledEvidence.journalBytes.toString().split("\n").filter(line => line.includes("scoped_write_document")).length }));
      assert.equal(reviewed.task.trace.outcome, "completed");
      assert.equal(reviewed.settlement.taskStatus, "completed");
      assert.equal(reviewed.task.mutationPolicy, "allowed");
      assert.ok(reviewed.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
      assert.equal(observations["workspace-scope"].status, "pass");
      const journalRows = settledEvidence.journalBytes.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      assert.equal(journalRows.some(row => row.body.tool === "scoped_write_document"), false);
      const workspace = workingTreeSnapshot(prepared.workspace), scopeInput = { ...expected,
        fact: reviewContract.facts.find(fact => fact.kind === "workspace-scope"), workspace };
      assert.equal(scopedMediationFactObservation(mediation, { ...scopeInput,
        workspace: { ...workspace, "docs/ops.md": "wt-content-v2:unmediated-change" } }).status, "unknown");
      assert.equal(scopedMediationFactObservation(mediation, { ...scopeInput,
        workspace: { ...workspace, "outside.txt": "wt-content-v2:outside-change" } }).status, "fail");
      assert.equal(runtime.metrics.unexpectedTurns, 0); assert.equal(runtime.metrics.realProviderCalls, 0);
      assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
      assert.equal(reviewed.unconsumedScript, 0);

    } finally { await runtime.close(); }
  });
});
