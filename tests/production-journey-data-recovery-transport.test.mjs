import { assertJourneyAcceptance } from "./helpers/production-journey-acceptance-mode.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { allConfiguredVerifierEvidenceCurrent, selectVerificationPlan, verificationEvidenceProvesStableTree } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const contentText = content => (content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
const prelude = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";

// Executable public obligations only. These tests do not import the private
// grader/oracle or sign independent acceptance assessments for the candidate.
const csvTests = prelude + String.raw`import { parseCsv } from '../src/data/csv.js';
test('commas separate fields and quoted commas remain inside their field', () => {
  assert.deepEqual(parseCsv('name,note\nAda,"one,two"'), [['name', 'note'], ['Ada', 'one,two']]);
});
test('escaped double quotes decode to one literal quote', () => {
  assert.deepEqual(parseCsv('"He said ""yes""",tail'), [['He said "yes"', 'tail']]);
  assert.deepEqual(parseCsv('""""'), [['"']]);
});
test('CRLF and LF delimit records while quoted newlines retain exact content', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\ne,f'), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
  assert.deepEqual(parseCsv('"first\nsecond","x\r\ny"\r\nlast,end'), [['first\nsecond', 'x\r\ny'], ['last', 'end']]);
});
test('leading trailing and middle empty fields are retained', () => {
  assert.deepEqual(parseCsv(',middle,\n,,tail'), [['', 'middle', ''], ['', '', 'tail']]);
});
test('an empty quoted final record without a newline is retained', () => {
  assert.deepEqual(parseCsv('""'), [['']]);
  assert.deepEqual(parseCsv('first\n""'), [['first'], ['']]);
  assert.deepEqual(parseCsv('"",last'), [['', 'last']]);
});
test('an unterminated quoted field throws SyntaxError', () => {
  for (const input of ['"unfinished', 'first,"unfinished\nnext', '"escaped ""quote']) {
    assert.throws(() => parseCsv(input), SyntaxError);
  }
});
`;

const dedupTests = prelude + String.raw`import { deduplicateEvents } from '../src/data/dedup.js';
test('each id appears once in first appearance order even when its retained value arrives later', () => {
  const firstA = { id: 'a', sequence: 1, value: 'old' }, firstB = { id: 'b', sequence: 3 };
  const newestA = { id: 'a', sequence: 5, value: 'new' }, firstC = { id: 'c', sequence: 2 };
  assert.deepEqual(deduplicateEvents([firstA, firstB, newestA, firstC]), [newestA, firstB, firstC]);
  assert.deepEqual(deduplicateEvents([]), []);
});
test('the greatest numeric sequence wins rather than arrival or lexical order', () => {
  const newest = { id: 'a', sequence: 10 }, lateOld = { id: 'a', sequence: 2 };
  assert.deepEqual(deduplicateEvents([{ id: 'a', sequence: -1 }, newest, lateOld]), [newest]);
  const numericString = { id: 'b', sequence: '10' };
  assert.deepEqual(deduplicateEvents([{ id: 'b', sequence: '2' }, numericString]), [numericString]);
});
test('equal numeric sequences retain the later occurrence', () => {
  const first = { id: 'a', sequence: 7, value: 'first' }, later = { id: 'a', sequence: 7, value: 'later' };
  assert.deepEqual(deduplicateEvents([first, later]), [later]);
  const stringTie = { id: 'a', sequence: '7', value: 'numeric tie' };
  assert.deepEqual(deduplicateEvents([first, stringTie]), [stringTie]);
});
test('id keys do not collide with object prototype names', () => {
  const events = [{ id: '__proto__', sequence: 2 }, { id: 'constructor', sequence: 1 }, { id: 'toString', sequence: 3 }];
  assert.deepEqual(deduplicateEvents(events), events);
});
test('input array and event objects are not mutated or sorted', () => {
  const events = [{ id: 'b', sequence: 2, value: { n: 1 } }, { id: 'a', sequence: 1 }, { id: 'b', sequence: 3 }];
  const before = structuredClone(events), identities = [...events];
  assert.deepEqual(deduplicateEvents(events), [events[2], events[1]]);
  assert.deepEqual(events, before); events.forEach((event, index) => assert.strictEqual(event, identities[index]));
});
`;

const checkpointTests = prelude + String.raw`import { resumeWork } from '../src/reliability/checkpoint.js';
test('resume starts at nextIndex and never invokes earlier items again', async () => {
  const calls = [], initial = { nextIndex: 2, results: ['done-a', 'done-b'] };
  const result = await resumeWork(['a', 'b', 'c', 'd'], initial, async (item, index) => { calls.push([item, index]); return 'done-' + item; });
  assert.deepEqual(calls, [['c', 2], ['d', 3]]);
  assert.deepEqual(result, { nextIndex: 4, results: ['done-a', 'done-b', 'done-c', 'done-d'] });
  assert.notStrictEqual(result, initial); assert.notStrictEqual(result.results, initial.results);
});
test('processing awaits one result at a time and preserves successful result order', async () => {
  let active = false; const calls = [];
  const result = await resumeWork([2, 3], { nextIndex: 0, results: [] }, async (item, index) => {
    assert.equal(active, false); active = true; calls.push(index); await Promise.resolve(); active = false; return item * 2;
  });
  assert.deepEqual(calls, [0, 1]); assert.deepEqual(result, { nextIndex: 2, results: [4, 6] });
});
test('a partial failure rethrows the same error with all completed results and the failed index', async () => {
  const failure = new Error('public expected failure'), calls = [];
  const initial = { nextIndex: 1, results: ['done-a'] };
  await assert.rejects(resumeWork(['a', 'b', 'c', 'd'], initial, async (item, index) => {
    calls.push(index); if (index === 2) throw failure; return 'done-' + item;
  }), error => error === failure);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(failure.checkpoint, { nextIndex: 2, results: ['done-a', 'done-b'] });
  assert.notStrictEqual(failure.checkpoint, initial); assert.notStrictEqual(failure.checkpoint.results, initial.results);
  const resumedCalls = [];
  const result = await resumeWork(['a', 'b', 'c', 'd'], failure.checkpoint, async (item, index) => { resumedCalls.push(index); return 'done-' + item; });
  assert.deepEqual(resumedCalls, [2, 3]);
  assert.deepEqual(result, { nextIndex: 4, results: ['done-a', 'done-b', 'done-c', 'done-d'] });
});
test('empty and fully completed checkpoints return without processing', async () => {
  let calls = 0;
  assert.deepEqual(await resumeWork([], { nextIndex: 0, results: [] }, () => { calls++; }), { nextIndex: 0, results: [] });
  const initial = { nextIndex: 1, results: ['done'] };
  const result = await resumeWork(['a'], initial, () => { calls++; });
  assert.equal(calls, 0); assert.deepEqual(result, initial); assert.notStrictEqual(result, initial);
});
test('malformed checkpoint shapes and index boundaries throw TypeError before processing', async () => {
  let calls = 0;
  for (const checkpoint of [null, undefined, [], 'checkpoint', {}, { nextIndex: 0, results: null },
    { nextIndex: -1, results: [] }, { nextIndex: 2, results: ['a', 'b'] }, { nextIndex: 0.5, results: [] },
    { nextIndex: '0', results: [] }, { nextIndex: NaN, results: [] }, { nextIndex: Infinity, results: [] },
    { nextIndex: 1, results: [] }, { nextIndex: 0, results: ['unexpected'] }]) {
    await assert.rejects(resumeWork(['a'], checkpoint, () => { calls++; }), TypeError);
  }
  assert.equal(calls, 0);
});
test('success and partial failure do not mutate items or the supplied checkpoint', async () => {
  for (const fail of [false, true]) {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }], initial = { nextIndex: 1, results: [{ id: 'done-a' }] };
    const before = structuredClone([items, initial]);
    const work = resumeWork(items, initial, async (item, index) => {
      if (fail && index === 2) throw new Error('expected failure'); return { id: 'done-' + item.id };
    });
    if (fail) await assert.rejects(work, /expected failure/); else await work;
    assert.deepEqual([items, initial], before);
  }
});
`;

const fixtures = [
  { id: "quoted-csv", lifecycle: "cold-start", tests: csvTests,
    variants: ["helper-reference", "public-contract-implementation", "escaped-quote-mutant"],
    candidate: reference => reference,
    mutate: source => source.replace("field += '\"'; i += 1;", "field += '\"\"'; i += 1;"),
    witness: "escaped double quotes decode to one literal quote",
    scout: "Inspected src/data/csv.js and package.json without editing. The naive parser needs stateful quoted-field parsing: preserve quoted commas and embedded LF/CRLF, decode doubled quotes, retain empty fields and the final record, and reject unterminated quotes with SyntaxError. Add focused public parser tests and run configured project verification after implementation." },
  { id: "stable-dedup", lifecycle: "steady-state", tests: dedupTests,
    variants: ["helper-reference", "equal-sequence-mutant"], candidate: reference => reference,
    mutate: source => source.replace("Number(event.sequence) >= Number(current.sequence)", "Number(event.sequence) > Number(current.sequence)"),
    witness: "equal numeric sequences retain the later occurrence",
    scout: "Inspected src/data/dedup.js and package.json without editing. Deduplication must retain first-seen id order while independently selecting the greatest numeric sequence; equal sequences select the later occurrence. Preserve the input array and events, cover ordering, ties and numeric comparison with focused tests, and run configured project verification after implementation." },
  { id: "resumable-checkpoint-partial-failure", lifecycle: "cold-start", tests: checkpointTests,
    variants: ["helper-reference", "restart-prefix-mutant"], candidate: reference => reference,
    mutate: source => source.replace("for (let index = checkpoint.nextIndex", "for (let index = 0"),
    witness: "resume starts at nextIndex and never invokes earlier items again",
    scout: "Inspected src/reliability/checkpoint.js and package.json without editing. The current implementation restarts at zero and loses prior successful results. Validate checkpoint shape, inclusive index bounds and results length before processing; resume only the remaining suffix, await each result, and rethrow the same failure with a new checkpoint at its failed index. Verify success, partial failure and resumed call indices without changing the input." }
];

for (const fixture of fixtures) for (const variant of fixture.variants) {
  test(`actual generated-package data recovery journey: ${fixture.id}/${variant}`, { timeout: 180000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-data-recovery-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, fixture.id);
    assert.equal(prepared.scenario.profile, "node-typescript"); assert.equal(prepared.scenario.lifecycle, fixture.lifecycle);
    assert.deepEqual(prepared.turns.map(turn => turn.id), ["scout", "implement", "verify"]);
    for (const [index, turn] of prepared.turns.entries()) {
      const declared = prepared.scenario.userJourney.turns[index];
      assert.equal(turn.message, fs.readFileSync(path.join(prepared.suiteRoot, declared.prompt), "utf8").trim());
      assert.equal(turn.workflow, undefined); assert.equal(turn.reconnectBefore, declared.reconnectBefore === true);
      assert.equal(turn.receiptUncertain, declared.receiptUncertain === true);
    }
    const [sourcePath, reference] = productionV3ReferenceSolution(fixture.id), candidate = fixture.candidate(reference);
    const mutant = variant.endsWith("-mutant"), wrong = fixture.mutate(candidate);
    assert.notEqual(wrong, candidate);
    const source = variant === "helper-reference" ? reference : mutant ? wrong : candidate;
    const testPath = "test/data-recovery-public.test.js";
    const initialSource = fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8");
    const packageHash = digest(fs.readFileSync(path.join(prepared.workspace, "package.json")));
    const generatedSettings = JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/settings.json"), "utf8"));
    const profile = resolveProjectProfileDocument(repositoryRoot,
      JSON.parse(fs.readFileSync(path.join(prepared.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
    const commands = selectVerificationPlan(profile, undefined, "source-change", prepared.workspace, [sourcePath, "test/**"]).commands;
    assert.ok(commands.length > 0);
    const resultText = mutant
      ? "Configured verification exposes a public contract violation. The implementation remains incomplete. No extra writes or successful completion are claimed."
      : "The public implementation and tests are present and configured verification was run. Report its actual pass/fail evidence and retain any original acceptance obligations that remain unverified.";
    const scripts = [
      [scriptedTool("data-scout-read-source", "read", { path: sourcePath }),
        scriptedTool("data-scout-read-package", "read", { path: "package.json" }), scriptedText(fixture.scout)],
      [scriptedTool("data-implement-read-source", "read", { path: sourcePath }),
        scriptedTool("data-write-source", "write", { path: sourcePath, content: source }),
        scriptedTool("data-write-tests", "write", { path: testPath, content: fixture.tests }),
        ...commands.map((command, index) => scriptedTool(`data-implement-verify-${index}`, "bash", { command })),
        scriptedText(resultText)],
      [scriptedTool("data-verify-read-source", "read", { path: sourcePath }),
        scriptedTool("data-verify-read-tests", "read", { path: testPath }),
        scriptedTool("data-review-verify-focused", "bash", { command: `node --test ${testPath}` }),
        ...commands.map((command, index) => scriptedTool(`data-review-verify-${index}`, "bash", { command })),
        scriptedTool("data-verify-diff", "bash", { command: `git diff -- ${sourcePath} ${testPath}` }),
        scriptedText(resultText + " Inspected the current source and diff without additional edits.")]
    ];
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace, agentDir: prepared.agentDir,
        repositoryRoot, transport: "loopback" });
      try {
        const results = [];
        for (const [index, turn] of prepared.turns.entries()) {
          const eventStart = runtime.rawEvents.length;
          // A declared verify request must execute its review script even if
          // implementation completed. It is not a recover-only replay turn.
          const result = await runtime.turn(turn, scripts[index]);
          result.verificationSnapshot = captureWorkspaceVerificationSnapshot(prepared.workspace);
          result.currentVerifier = Boolean(result.task && allConfiguredVerifierEvidenceCurrent(result.task,
            result.verificationSnapshot.digest, result.verificationSnapshot.workspaceRevisionDigest));
          result.toolEvents = runtime.rawEvents.slice(eventStart).filter(event => event.type === "tool_execution_start")
            .map(event => ({ id: event.toolCallId, name: event.toolName }));
          result.sourceHash = digest(fs.readFileSync(path.join(prepared.workspace, sourcePath)));
          result.testHash = fs.existsSync(path.join(prepared.workspace, testPath)) ? digest(fs.readFileSync(path.join(prepared.workspace, testPath))) : null;
          results.push(result);
          const verifications = runtime.rawEvents.slice(eventStart).filter(event => event.type === "tool_execution_end"
            && /^data-(?:implement|review)-verify-/.test(event.toolCallId));
          t.diagnostic(JSON.stringify({ scenario: fixture.id, variant, turn: turn.id, profile: prepared.scenario.profile,
            lifecycle: fixture.lifecycle, promptSha256: digest(turn.message), expectedSourceSha256: digest(source),
            sourceSha256: result.sourceHash, testSha256: result.testHash, sessionRef: result.sessionRef, operationRef: result.operationRef,
            receipt: result.receipt, settlement: result.settlement, wireSettlement: result.wireSettlement, transport: result.transport,
            task: result.task && { taskRunId: result.task.taskRunId, sessionId: result.task.sessionId,
              operatorRequest: result.task.operatorRequest, outcome: result.task.trace.outcome, changeMode: result.task.changeMode,
              verifyCommands: result.task.verifyCommands, verifyEvidence: result.task.verifyEvidence,
              acceptanceCriteria: result.task.acceptanceCriteria, criteria: result.task.acceptanceReceipt?.criteria },
            currentVerifier: result.currentVerifier, scriptedTurns: result.scriptedTurns,
            unconsumedScript: result.unconsumedScript, toolEvents: result.toolEvents, metrics: runtime.metrics,
            verifications: verifications.map(event => ({ id: event.toolCallId, isError: event.isError, output: contentText(event.result?.content) })) }));
        }
        // Keep every declared turn's observations even when the correct final
        // completion expectation remains RED despite a correct shared reference.
        const scout = results[0], implementation = results[1], last = results[2], transport = runtime.transport.snapshot();
        const verifications = runtime.rawEvents.filter(event => event.type === "tool_execution_end"
          && /^data-(?:implement|review)-verify-/.test(event.toolCallId));
        const failures = verifications.filter(event => event.isError === true);
        t.diagnostic(JSON.stringify({ scenario: fixture.id, variant, observedTurns: results.length, declaredTurns: 3,
          transport, metrics: runtime.metrics, projectResources: runtime.projectResources,
          extensionErrors: runtime.extensionErrors, serviceErrors: runtime.serviceErrors }));
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.ok(runtime.metrics.unexpectedTurns <= 1, "only the existing bounded diagnostic continuation is permitted");
        assert.ok(runtime.projectResources.length > 0);
        for (const resources of runtime.projectResources) {
          assert.deepEqual(resources.packages, generatedSettings.packages);
          assert.ok(resources.extensions.includes(path.join(repositoryRoot, "packages/piagent-webui/extension/piagent-webui.ts")));
        }
        assert.equal(transport.kind, "loopback-http-websocket"); assert.equal(transport.unauthenticatedCatalogStatus, 401);
        assert.equal(transport.bootstrapCount, 1); assert.equal(transport.connections, 1); assert.equal(transport.reconnects, 0);
        assert.equal(transport.commandDispatches, 3); assert.equal(transport.uncertainSends, 0); assert.equal(transport.droppedConnections, 0);
        assert.equal(new Set(results.map(result => result.sessionRef)).size, 1);
        assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
        assert.equal(new Set(results.map(result => result.operationRef)).size, 3);
        for (const [index, result] of results.entries()) {
          assert.equal(result.unconsumedScript, 0); assert.equal(result.command.payload.message, prepared.turns[index].message);
          assert.equal(result.command.payload.workflow, undefined);
          assert.deepEqual(result.wireSettlement.payload, result.settlement);
          assert.equal(result.settlement.sessionRef, result.sessionRef); assert.equal(result.settlement.operationRef, result.operationRef);
          assert.equal(result.settlement.messageRequestId, result.command.payload.messageRequestId);
          assert.equal(runtime.observed.filter(event => event.kind === "operation.settled"
            && event.payload.operationRef === result.operationRef).length, 1);
          assert.ok(result.task); assert.equal(result.task.sessionId, result.sessionId);
          if (index === 0 || index === 2) assert.equal(result.toolEvents.some(event => ["write", "edit", "apply_patch"].includes(event.name)), false);
        }
        assert.equal(scout.sourceHash, digest(initialSource)); assert.equal(scout.testHash, null);
        assert.equal(scout.task.changeMode, "read-only");
        assert.equal(implementation.task.changeMode, "source-change");
        assert.notEqual(implementation.task.taskRunId, scout.task.taskRunId);
        if (implementation.task.trace.outcome !== "completed") {
          assert.equal(last.task.taskRunId, implementation.task.taskRunId,
            "verification must retain the unresolved implementation task");
        }
        assert.equal(implementation.task.operatorRequest, prepared.turns[1].message);
        assert.equal(last.sourceHash, implementation.sourceHash); assert.equal(last.testHash, implementation.testHash);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, sourcePath), "utf8"), source);
        assert.equal(fs.readFileSync(path.join(prepared.workspace, testPath), "utf8"), fixture.tests);
        assert.equal(digest(fs.readFileSync(path.join(prepared.workspace, "package.json"))), packageHash);
        assert.equal(runtime.rawEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "write").length, 2);
        assert.equal(last.scriptedTurns, scripts[2].length, "verify must execute focused and full checks without restarting source work or duplicating a diagnosis");
        assert.ok(verifications.length > 0);
        const focused = verifications.filter(event => event.toolCallId === "data-review-verify-focused");
        assert.equal(focused.length, 1, "the declared verify turn must run the public test file explicitly");
        const focusedOutput = contentText(focused[0].result?.content);
        assert.doesNotMatch(focusedOutput, /reused exact verifier evidence|skipping running files|being called recursively/);
        assert.match(focusedOutput, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
        assert.match(focusedOutput, /(?:#|ℹ)\s+skipped 0\b/);
        assert.equal(focused[0].isError, mutant);
        for (const event of verifications) {
          const output = contentText(event.result?.content);
          assert.doesNotMatch(output, /skipping running files|being called recursively/);
          if (output.includes("reused exact verifier evidence")) {
            assert.match(event.toolCallId, /^data-review-/);
            assert.ok(implementation.task.verifyEvidence.some(evidence => verificationEvidenceProvesStableTree(evidence,
              last.verificationSnapshot.digest, last.verificationSnapshot.workspaceRevisionDigest)));
          } else {
            assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/); assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
          }
        }
        if (mutant) {
          assert.ok(failures.length > 0, "the wrong candidate must fail the actual configured verifier");
          const output = failures.map(event => contentText(event.result?.content)).join("\n");
          assert.match(output, /ERR_ASSERTION/);
          assert.match(output, new RegExp(`(?:✖ |not ok \\d+ - )${fixture.witness}`));
          assert.match(focusedOutput, /ERR_ASSERTION/);
          assert.match(focusedOutput, new RegExp(`(?:✖ |not ok \\d+ - )${fixture.witness}`));
          assert.equal(last.currentVerifier, false);
          assert.ok(results.slice(1).every(result => result.task.trace.outcome !== "completed" && result.settlement.taskStatus !== "completed"));
        } else {
          assert.equal(failures.length, 0, "the candidate must satisfy the executable public contract before claiming completion");
          const sourceTask = last.task.taskRunId === implementation.task.taskRunId ? last.task : implementation.task;
          assert.equal(allConfiguredVerifierEvidenceCurrent(sourceTask, last.verificationSnapshot.digest,
            last.verificationSnapshot.workspaceRevisionDigest), true);
          assert.equal(scout.task.trace.outcome, "completed", "the read-only scout must also complete");
          assert.equal(last.task.trace.outcome, "completed", "a correct current candidate must complete after every declared turn");
          assert.equal(last.settlement.taskStatus, "completed"); assert.equal(last.settlement.settlement, "completed");
          if (prepared.scenario.id === "resumable-checkpoint-partial-failure") assertJourneyAcceptance(repositoryRoot, last.task, sourceTask);
          else assert.ok(last.task.acceptanceReceipt.criteria.every(criterion => criterion.status === "satisfied"));
        }
      } finally { await runtime.close(); }
    });
  });
}
