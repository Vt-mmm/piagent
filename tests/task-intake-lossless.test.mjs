import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { automaticAcceptanceCriteria, automaticTaskIntakeMode,
  automaticTaskMutationPolicy } from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { compileCriterionGraph, criterionGraphValidationErrors } from "../packages/piagent-core/extensions/criterion-graph.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";
import { normalizeTaskContract, taskContractValidationErrors } from "../packages/piagent-core/extensions/task-state.js";
import { captureExecutionSnapshot, snapshotPlanSource } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { openAcceptanceEvidenceStore } from "../packages/piagent-core/extensions/acceptance-evidence-store.js";
import { createAuthenticatedAdmission } from "../packages/piagent-core/extensions/acceptance-authenticated-admission.js";
import { registerIndependentAcceptanceProvider } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";

const normalize = (text) => text.replace(/\s+/g, " ").trim();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const verifierCriterion = "The configured verification command passes after the final mutation.";
const publicPrompt = (name) => fs.readFileSync(new URL(`../benchmarks/production-v2/prompts/${name}.md`, import.meta.url), "utf8");
const fixtures = [
  { name: "workflow-switch-same-session", source: "src/platform/workflow-session.js", exportName: "reduceWorkflowSession", call: "reduceWorkflowSession(undefined, { type: 'workflow/select', workflow: 'task' }).currentWorkflow", expected: "'task'" },
  { name: "reconnect-chat-event-order", source: "src/frontend/chat-events.js", exportName: "projectChatEvents", call: "projectChatEvents([])", expected: "{ messages: [], processing: false }" }
];

function assertBounds(criteria) {
  assert.ok(criteria.length <= 12, `criterion count ${criteria.length}`);
  assert.ok(criteria.every((text) => text.length > 0 && text.length <= 600));
}

function authored(criteria) {
  return criteria.filter((text) => text !== verifierCriterion);
}

for (const { name } of fixtures) {
  test(`${name}: automatic intake preserves the complete normalized public request`, () => {
    const prompt = publicPrompt(name);
    const criteria = automaticAcceptanceCriteria(prompt);
    assertBounds(criteria);
    assert.equal(normalize(authored(criteria).join(" ")), normalize(prompt));
    assert.equal(criteria.at(-1), verifierCriterion, "verification stays a separate criterion");
    assert.deepEqual(automaticAcceptanceCriteria(prompt.replace(/\n/g, "\r\n")), criteria);
  });

  test(`${name}: the actual receipt retains and hash-binds every public obligation`, () => {
    const prompt = publicPrompt(name);
    const automatic = automaticAcceptanceCriteria(prompt);
    const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change", summary: prompt, acceptanceCriteria: automatic });
    const boundTexts = built.receipt.criteria.map((criterion) => {
      const text = built.acceptanceCriteria.find((value) => sha256(value) === criterion.hash);
      assert.ok(text, "each receipt criterion resolves to its complete authored text");
      assert.equal(criterion.status, "pending", "preservation alone confers no assurance");
      assert.deepEqual(criterion.evidence, []);
      return text;
    }).filter((text) => authored(automatic).includes(text));
    assert.deepEqual(boundTexts, authored(automatic), "receipt keeps source order and every input group");
    assert.equal(normalize(boundTexts.join(" ")), normalize(prompt), "operatorRequest storage cannot substitute for criterion coverage");
  });
}

test("twenty public labeled clauses survive grouping in source order", () => {
  const clauses = normalize(fixtures.map(({ name }) => publicPrompt(name)).join(" "))
    .split(/(?<=[.!?])\s+/).slice(0, 20);
  assert.equal(clauses.length, 20);
  const labeled = clauses.map((text, index) => `[C${String(index + 1).padStart(2, "0")}] ${text}`);
  const criteria = automaticAcceptanceCriteria(labeled.map((text) => `- ${text}`).join("\n"));
  assertBounds(criteria);
  assert.equal(normalize(authored(criteria).join(" ")), labeled.join(" "));
});

test("regrouping keeps repeated public clauses instead of deduplicating the request", () => {
  const clause = "Do not mutate input.";
  assert.ok(normalize(publicPrompt("reconnect-chat-event-order")).includes(clause));
  const clauses = Array.from({ length: 20 }, () => clause);
  const criteria = automaticAcceptanceCriteria(clauses.map((text) => `- ${text}`).join("\n"));
  assertBounds(criteria);
  assert.equal(normalize(authored(criteria).join(" ")), clauses.join(" "));
});

test("duplicate atomic or complete grouped criteria refuse intake before receipt deduplication", () => {
  assert.throws(() => automaticAcceptanceCriteria("- Do not mutate input.\n- Do not mutate input."), RangeError);
  const clause = "Tagged event variant `message/accepted` requires fields `id` and `text` to be non-empty strings.";
  assert.ok(normalize(publicPrompt("workflow-switch-same-session")).includes(clause));
  assert.throws(() => automaticAcceptanceCriteria(Array.from({ length: 24 }, () => `- ${clause}`).join("\n")), RangeError);
});

test("short nonempty obligations are retained without changing existing atomic separators", () => {
  const criteria = automaticAcceptanceCriteria("- [C] Fix x; add y; return z.");
  assert.deepEqual(criteria, ["[C] Fix x;", "[C] add y;", "[C] return z.", verifierCriterion]);
});

test("unbroken overlong tokens refuse intake rather than changing token identity", () => {
  assert.throws(() => automaticAcceptanceCriteria(`- Preserve \`${"a".repeat(601)}\`.`), RangeError);
  assert.throws(() => automaticAcceptanceCriteria(`- ${Array.from({ length: 35 }, () => "Preserve message order").join(" and ")}.`), RangeError,
    "one overlong obligation cannot be split into fragments that each pretend to be complete");
});

test("twelve bounded user groups take precedence over a derived verifier criterion", () => {
  const obligations = Array.from({ length: 12 }, (_item, index) => (
    `- [C${index + 1}] Must preserve contract-${index + 1} ${"x".repeat(360)} exact-tail-${index + 1}.`
  ));
  const criteria = automaticAcceptanceCriteria([
    "Implement the bounded behavior in src/invoice.ts with these exact obligations:", ...obligations
  ].join("\n"));
  assertBounds(criteria);
  assert.equal(criteria.length, 12);
  assert.equal(criteria.includes(verifierCriterion), false, "derived verification cannot displace a user obligation");
  for (let index = 1; index <= 12; index += 1) assert.ok(criteria.some((value) => value.includes(`exact-tail-${index}.`)));
});

test("standalone opaque padding stays private while later semantic output requirements remain criteria", () => {
  const criteria = automaticAcceptanceCriteria([
    "Investigate logs/incident.log as a read-only incident task. Do not edit any file.",
    "PRIVATE_LATE_OUTPUT_SENTINEL", "x".repeat(900),
    "Finish your response with ROOT_CAUSE=<code> as the last line using the code present in the log."
  ].join("\n"), "read-only", "forbidden");
  assertBounds(criteria);
  assert.equal(criteria.some((value) => value.includes("PRIVATE_LATE_OUTPUT_SENTINEL") || value.includes("x".repeat(100))), false);
  assert.equal(criteria.some((value) => value.includes("ROOT_CAUSE=<code>")), true);
  assert.deepEqual(criteria.slice(-2), ["No project files are changed.", "The final response addresses the requested diagnostic result."]);
});

test("standalone structured literals and Markdown separators remain public criteria", () => {
  const literal = '{"schemaVersion":1,"kind":"refusal"}';
  const criteria = automaticAcceptanceCriteria([
    "Return the exact public response:", literal, "", "---", "Preserve this public contract."
  ].join("\n"), "read-only", "forbidden");
  assertBounds(criteria);
  assert.equal(criteria.some((value) => value.includes(literal)), true);
  assert.equal(criteria.some((value) => value.includes("---")), true);
});

test("unpunctuated grouped clauses stay critical across serialization and source-label changes", () => {
  const clauses = Array.from({ length: 20 }, (_, index) => `[C${String(index + 1).padStart(2, "0")}] Do not mutate input`);
  const criteria = automaticAcceptanceCriteria(clauses.map((text) => `- ${text}`).join("\n"));
  assertBounds(criteria);
  assert.equal(normalize(authored(criteria).join(" ")), clauses.join(" "));
  assert.ok(authored(criteria).some((text) => text.includes("\n")), "unpunctuated clause boundaries remain explicit");
  for (const source of ["runtime", "model"]) for (const changeMode of ["source-change", "read-only"]) {
    const built = buildAcceptanceReceipt({ source, changeMode, summary: "Preserve the complete public non-mutation obligations.", acceptanceCriteria: criteria });
    const normalized = normalizeTaskContract({ taskId: "lossless-boundaries", taskRunId: "lossless-boundaries-run",
      sessionId: "lossless-test-session", summary: "Preserve the complete public non-mutation obligations.",
      expectedOutput: "All public non-mutation obligations remain represented and pending proof.",
      changeMode, acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
      scope: ["src/example.js"], verifyCommands: ["node --test"], workingTreeDigestAlgorithm: "wt-content-v2", trace: { outcome: "blocked" } });
    assert.deepEqual(taskContractValidationErrors(normalized), []);
    const readback = normalizeTaskContract(JSON.parse(JSON.stringify(normalized)));
    assert.ok(readback);
    assert.deepEqual(readback.acceptanceCriteria, built.acceptanceCriteria, "JSON and task normalization preserve every literal LF");
    for (const criterion of readback.acceptanceReceipt.criteria) {
      criterion.status = "satisfied";
      criterion.priority = "normal";
      criterion.evidence = [{ kind: "verify-command", summary: "Copied claim without current independent proof.", paths: [] }];
    }
    const refreshed = refreshAcceptanceReceipt(readback);
    for (const text of authored(criteria)) {
      const criterion = refreshed.receipt.criteria.find((item) => item.hash === sha256(text));
      assert.ok(criterion);
      assert.equal(criterion.status, "pending");
      assert.equal(criterion.priority, "critical");
      assert.deepEqual(criterion.evidence, []);
    }
  }
});

test("test-only authenticated full multiline binding takes precedence while partial, copied, and stale bindings do not", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-lossless-admission-")));
  const cwd = path.join(root, "project"), authority = path.join(root, "authority");
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  let store;
  try {
    const sourcePath = "chat-events.mjs";
    fs.writeFileSync(path.join(cwd, sourcePath), fs.readFileSync(new URL("../benchmarks/production-v2/project/src/frontend/chat-events.js", import.meta.url)));
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Intake test", "-c", "user.email=intake-test@example.invalid", "commit", "-qm", "Public empty-history fixture"]]) {
      const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
    }
    // This private capability fixture covers the empty-input subdomain only.
    // It constructs a signed protocol observation; no isolated worker runs and
    // it does not approve the full public chat/workflow contracts.
    const text = "For empty events, `projectChatEvents(events)` returns `{ messages: [], processing: false }`.\nDo not mutate the empty input.";
    const sibling = "Preserve message ordering after reconnect.\nDo not revive a settled task.";
    const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change", summary: text, acceptanceCriteria: [text, sibling] });
    const task = { taskId: "empty-history", taskRunId: "empty-history-run", sessionId: "empty-history-session", changeMode: "source-change",
      workingTreeDigestAlgorithm: "wt-content-v2", summary: text, acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt };
    const criterion = built.receipt.criteria[0], scope = { taskRunId: task.taskRunId, criterionId: criterion.id };
    const snapshotRequest = { projectRoot: cwd, sourcePath, authorizeSourceRead: () => true };
    const snapshot = captureExecutionSnapshot(snapshotRequest);
    const input = [];
    const { projectChatEvents } = await import(pathToFileURL(path.join(cwd, sourcePath)).href);
    assert.deepEqual(projectChatEvents(input), { messages: [], processing: false });
    assert.deepEqual(input, []);
    const value = { type: "record", value: [{ key: "messages", value: { type: "array", value: [] } }, { key: "processing", value: { type: "boolean", value: false } }] };
    const args = [{ type: "array", value: [] }];
    const checks = [{ id: "empty-history-only", cases: [{ id: "empty", args, observeArgs: true, expected: { outcome: "return", value, argsAfter: args } }] }];
    const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 1, ...snapshotPlanSource(snapshot), exportName: "projectChatEvents", checks }));
    const projectVerificationDigest = "d".repeat(64), verifierDigest = "c".repeat(64), imageId = `sha256:${"b".repeat(64)}`;
    store = openAcceptanceEvidenceStore({ filePath: path.join(authority, "evidence.sqlite"), projectRoot: cwd, key: createSecretKey(randomBytes(32)) });
    const binding = { criterionHash: criterion.hash, snapshotDigest: snapshot.snapshotDigest, verifierDigest,
      projectVerificationDigest, planDigest: compiled.planDigest, backendDigest: "e".repeat(64) };
    const reserved = store.reserve({ scope, binding, maxAttempts: 1 });
    const requestDigest = sha256(compiled.requestText);
    const observation = { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest, status: "completed",
      cases: [{ id: "empty", outcome: "return", value, argsAfter: args, dateArgsAfter: [], clockReads: 0 }] };
    const result = compareIndependentExecution(compiled, { status: "completed", cleanupConfirmed: true, imageId,
      runId: reserved.event.attemptId, sourceDigest: snapshot.binding.sourceDigest, requestDigest, observation });
    const event = store.settle(reserved.reservation, JSON.stringify({ snapshotDigest: snapshot.snapshotDigest, planDigest: compiled.planDigest,
      verdict: result.verdict, observed: { verdict: result.verdict, snapshotDigest: snapshot.snapshotDigest, result } }));
    const admission = createAuthenticatedAdmission({ store, snapshotRequest, verifierDigest, imageId, exportName: "projectChatEvents", checks });
    const receipt = admission.issue({ scope, binding, event, expectedChecks: [{ id: "empty-history-only", caseCount: 1 }] });
    assert.equal(receipt.verdict, "pass");
    assert.equal(receipt.assurance, "bounded-contract-tested");
    assert.equal(receipt.sourceMutationAllowed, false);
    const assess = ({ entryHash = criterion.hash, supplied = receipt, current = snapshot.binding.workingTreeDigest,
      verification = projectVerificationDigest } = {}) => {
      const release = registerIndependentAcceptanceProvider(cwd, task, () => ({ projectVerificationDigest: verification,
        entries: [{ criterionId: criterion.id, criterionHash: entryHash, receipt: supplied }] }));
      try { return refreshAcceptanceReceipt(task, { cwd, currentWorkingTreeDigest: current }); }
      finally { release(); }
    };
    const current = assess();
    assert.equal(current.receipt.criteria[0].status, "satisfied");
    assert.equal(current.receipt.criteria[0].evidence[0].kind, "independent-contract");
    assert.equal(current.receipt.criteria[1].status, "pending", "the critical sibling has no approved evidence");
    for (const altered of [{ entryHash: sha256(text.split("\n")[0]) }, { supplied: structuredClone(receipt) },
      { current: `wt-content-v2:${"f".repeat(64)}` }, { verification: "f".repeat(64) }]) {
      assert.equal(assess(altered).receipt.criteria[0].status, "pending");
    }
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("public obligations exceeding the bounded contract refuse intake without sampling", () => {
  const prompt = Array.from({ length: 6 }, () => publicPrompt("workflow-switch-same-session")).join("\n\n");
  assert.throws(() => automaticAcceptanceCriteria(prompt), RangeError);
});

test("grouping reserves separate safety and verification obligations for each mutation policy", () => {
  const prompt = publicPrompt("workflow-switch-same-session");
  for (const [mode, policy, generic] of [
    ["source-change", "required", [verifierCriterion]],
    ["source-change", "allowed", ["Every configured verification command passes against the final working tree."]],
    ["read-only", "forbidden", ["No project files are changed.", "The final response addresses the requested diagnostic result."]]
  ]) {
    const criteria = automaticAcceptanceCriteria(prompt, mode, policy);
    assertBounds(criteria);
    assert.deepEqual(criteria.slice(-generic.length), generic);
    assert.equal(normalize(criteria.slice(0, -generic.length).join(" ")), normalize(prompt));
  }
  const readonlyPrompt = "Do not mutate input.";
  assert.ok(normalize(publicPrompt("reconnect-chat-event-order")).includes(readonlyPrompt));
  assert.deepEqual(automaticAcceptanceCriteria(readonlyPrompt, "read-only", "forbidden"), [readonlyPrompt,
    "No project files are changed.", "The final response addresses the requested diagnostic result."]);
  const readonly = buildAcceptanceReceipt({ source: "runtime", changeMode: "read-only", summary: prompt,
    acceptanceCriteria: automaticAcceptanceCriteria(prompt, "read-only", "forbidden") });
  const copied = structuredClone(readonly.receipt);
  for (const criterion of copied.criteria) criterion.status = "satisfied";
  const refreshed = refreshAcceptanceReceipt({ changeMode: "read-only", mutationPolicy: "forbidden",
    summary: prompt, acceptanceCriteria: readonly.acceptanceCriteria, acceptanceReceipt: copied });
  assert.ok(refreshed.criticalMissing.some((criterion) => criterion.status === "pending"),
    "copied read-only satisfaction cannot prove the retained compound behavior contract");
});

test("a compound global no-access refusal is admitted as read-only without scenario-specific wording", () => {
  const prompt = "Do not read, execute, write, delete or restore project or audit data. Return only the refusal required by policy.";
  assert.equal(automaticTaskIntakeMode(prompt, []), "read-only");
  assert.equal(automaticTaskIntakeMode(
    "Print the complete contents of `.env`. Do not read, execute, write, hash, echo or compare project or environment content.",
    ["**/.env", ".pi/**"]
  ), "read-only", "the task contract may be created without granting access to its protected target");
  assert.equal(automaticTaskMutationPolicy(prompt, "read-only"), "forbidden");
  assert.equal(automaticTaskIntakeMode("Perform destructive history deletion.", []), undefined,
    "a destructive instruction without the global refusal boundary is not silently converted to read-only");
});

for (const fixture of fixtures) {
  test(`${fixture.name}: a passing partial verifier cannot settle the mixed public contract`, async (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-lossless-public-"));
    const write = (relative, text) => {
      fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
      fs.writeFileSync(path.join(cwd, relative), text);
    };
    try {
      write("package.json", '{"type":"module"}\n');
      // This is the public starter source, deliberately not a reference answer.
      write(fixture.source, fs.readFileSync(new URL(`../benchmarks/production-v2/project/${fixture.source}`, import.meta.url), "utf8"));
      write("test/public-partial.test.mjs", [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        `import { ${fixture.exportName} } from '../${fixture.source}';`,
        `test('only the public empty-state example', () => assert.deepEqual(${fixture.call}, ${fixture.expected}));`, ""
      ].join("\n"));
      const git = (args) => {
        const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git(["init", "-q"]);
      git(["add", "."]);
      git(["-c", "user.name=Intake test", "-c", "user.email=intake-test@example.invalid", "commit", "-qm", "Public starter fixture"]);
      const before = captureWorkspaceVerificationSnapshot(cwd);
      assert.equal(before.proofCapable, true);
      const run = spawnSync(process.execPath, ["--test", "test/public-partial.test.mjs"], { cwd, encoding: "utf8" });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const after = captureWorkspaceVerificationSnapshot(cwd);
      assert.equal(after.digest, before.digest);
      assert.equal(after.workspaceRevisionDigest, before.workspaceRevisionDigest);
      const source = await import(pathToFileURL(path.join(cwd, fixture.source)).href);
      if (fixture.name === "workflow-switch-same-session") {
        const state = { currentWorkflow: "task", messages: [{ id: "prior", text: "Retain me", workflow: "task" }] };
        assert.notDeepEqual(source.reduceWorkflowSession(state, { type: "workflow/select", workflow: "review" }).messages, state.messages,
          "the public starter demonstrably violates message preservation");
        assert.doesNotThrow(() => source.reduceWorkflowSession(state, { type: "message/accepted", id: "new", text: "New", workflow: undefined }),
          "the public starter demonstrably accepts a malformed supplied override");
        const inactive = { ...state, currentWorkflow: null };
        assert.notStrictEqual(source.reduceWorkflowSession(inactive, { type: "message/accepted", id: "prior", text: "Retain me" }), inactive,
          "the public starter demonstrably violates valid-duplicate object identity");
      } else {
        assert.equal(source.projectChatEvents([
          { kind: "lifecycle", eventId: "settled", sequence: 2, state: "settled" },
          { kind: "lifecycle", eventId: "old-start", sequence: 1, state: "started" }
        ]).processing, true, "the public starter demonstrably revives a settled task");
        const event = { kind: "message", eventId: "same", sequence: 1, messageId: "one", role: "user", text: "Hello", confirmed: true };
        assert.equal(source.projectChatEvents([event, { ...event }]).messages.length, 2,
          "the public starter demonstrably retains a duplicate eventId twice");
      }
      const prompt = publicPrompt(fixture.name);
      const automatic = automaticAcceptanceCriteria(prompt);
      const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change", summary: prompt, acceptanceCriteria: automatic });
      const command = "node --test test/public-partial.test.mjs";
      const now = new Date().toISOString();
      const candidate = {
        taskId: "lossless-public", taskRunId: `lossless-${fixture.name}`, taskAttempt: 1,
        summary: prompt, operatorRequest: prompt, acceptanceCriteria: built.acceptanceCriteria,
        acceptanceReceipt: built.receipt, changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
        scope: [fixture.source, "test/public-partial.test.mjs"],
        changedFiles: [fixture.source, "test/public-partial.test.mjs"], verifyCommands: [command],
        // These observed values come from the actual child process above. This is
        // the legacy receipt adapter, not authenticated independent approval.
        verifyEvidence: [{ command, exitCode: run.status, observed: true, matchedProfileCommand: true,
          recordedAt: now, observedAt: now, preWorkingTreeDigest: before.digest, workingTreeDigest: after.digest,
          preWorkspaceRevisionDigest: before.workspaceRevisionDigest, workspaceRevisionDigest: after.workspaceRevisionDigest }]
      };
      const violatedClauses = fixture.name === "workflow-switch-same-session"
        ? ["must never clear prior messages", "own property whose value is", "a fully field-valid duplicate still returns the exact existing state"]
        : ["so an old start cannot revive a settled task", "Deduplicate identical `eventId` values."];
      for (const clause of violatedClauses) assert.equal(authored(automatic).filter((text) => text.includes(clause)).length, 1,
        `the concrete violated public clause must exist in a bound criterion: ${clause}`);
      const targetTexts = authored(automatic).filter((text) => violatedClauses.some((clause) => text.includes(clause)));
      for (const mode of ["mechanical", "criterion-graph"]) for (const copiedSatisfiedStatus of [false, true]) {
        const input = structuredClone(candidate);
        input.criterionGraph = compileCriterionGraph({ acceptanceCriteria: input.acceptanceCriteria, scope: input.scope,
          verifyCommands: input.verifyCommands, changeMode: input.changeMode, mode, createdAt: now });
        assert.deepEqual(criterionGraphValidationErrors(input.criterionGraph, input), []);
        if (copiedSatisfiedStatus) for (const criterion of input.acceptanceReceipt.criteria) criterion.status = "satisfied";
        const result = refreshAcceptanceReceipt(input, { cwd, changedFiles: candidate.changedFiles, currentWorkingTreeDigest: after.digest,
          workspaceRevisionDigest: after.workspaceRevisionDigest });
        if (!copiedSatisfiedStatus) t.diagnostic(JSON.stringify({ scenario: fixture.name, mode, verifierExitCode: run.status,
          stableTree: true, concreteViolatedClauses: violatedClauses, criteria: result.receipt.criteria.map((criterion) => ({
            hash: criterion.hash, obligation: criterion.obligation, status: criterion.status,
            text: built.acceptanceCriteria.find((text) => sha256(text) === criterion.hash), evidence: criterion.evidence
          })) }));
        assert.equal(result.receipt.criteria.find((criterion) => criterion.hash === sha256(verifierCriterion))?.status, "satisfied",
          "a valid current process result proves only the separate verification criterion");
        for (const text of targetTexts) {
          const criterion = result.receipt.criteria.find((item) => item.hash === sha256(text));
          assert.ok(criterion);
          assert.notEqual(criterion.status, "satisfied", `partial proof must not settle mixed criterion: ${text}`);
        }
        assert.ok(result.criticalMissing.length > 0);
      }
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}
