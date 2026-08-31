import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceProofGuidance } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { compileCriterionGraph, criterionGraphGuidance } from "../packages/piagent-core/extensions/criterion-graph.js";
import { acceptanceLanguageAdapterForPath, isAcceptanceTestPath } from "../packages/piagent-core/extensions/acceptance-language-adapters.js";
import { taskPerformanceAssurance } from "../packages/piagent-core/runtime/quality/performance-assurance.ts";
import { automaticTaskExecutionGuidance, RUNTIME_SOURCE_REUSE_GUIDANCE, taskCriticalProofSection } from "../packages/piagent-core/runtime/registration/task-start-guidance.ts";
import { RUNTIME_INTAKE_MESSAGE_MAX_CHARS } from "../packages/piagent-core/runtime/runtime-limits.ts";
import { automaticAcceptanceCriteria, automaticTaskSummary, boundedRuntimeIntakeMessage } from "../packages/piagent-core/runtime/workflows/task-intake.ts";

test("bounded automatic intake preserves generated semantic proof bodies and criterion tags before verification", (t) => {
  // Public, task-derived semantics only: no campaign fixture, grader, model
  // output, provider call, or expected implementation is used by this test.
  const prompt = [
    "Fix `isDeadlineReached(timestamp, now)` in `src/scheduling/deadline.js`.",
    "",
    "A deadline is reached when `now` is equal to or later than its timestamp.",
    "Accept an ISO timestamp string or `Date` for `timestamp`, and a millisecond",
    "number or `Date` for `now`. Invalid dates must throw `TypeError`; do not use the",
    "machine's current time when an explicit falsey value is provided. Preserve the",
    "API and verify the project."
  ].join("\n");
  const task = {
    taskId: "fix-is-deadline-reached-timestamp-now-in-src-scheduling-deadline-js",
    changeMode: "source-change",
    mutationPolicy: "required",
    summary: automaticTaskSummary(prompt),
    operatorRequest: prompt,
    expectedOutput: "The requested bounded change is implemented and passes the configured verification.",
    acceptanceCriteria: automaticAcceptanceCriteria(prompt, "source-change", "required"),
    scope: ["src/scheduling/deadline.js", "test/**", "tests/**", "spec/**", "__tests__/**"],
    verifyCommands: ["npm run type-check && npm run lint && npm test"]
  };
  task.criterionGraph = compileCriterionGraph({
    acceptanceCriteria: task.acceptanceCriteria, scope: task.scope, verifyCommands: task.verifyCommands,
    changeMode: task.changeMode, mode: "criterion-graph", createdAt: "2026-01-01T00:00:00.000Z"
  });
  const assurance = taskPerformanceAssurance(task);
  const proof = taskCriticalProofSection(task, [], ["src/scheduling/deadline.js"],
    acceptanceProofGuidance, isAcceptanceTestPath, acceptanceLanguageAdapterForPath, assurance.requiresReview);
  const hints = acceptanceProofGuidance(task);
  const verifier = `Verifier 1 (run as an exact standalone shell command): ${task.verifyCommands[0]}`;
  // Match the production automatic-intake section layout. This ordinary
  // contract exceeds the display budget without artificial padding.
  const intake = [
    `Piagent runtime task: ${task.taskId}; initial focus (advisory): ${task.scope.join(", ")}.`,
    "The complete operator request above is the authoritative acceptance contract; runtime keeps its full criteria, so do not restate or re-scout it.",
    `Assurance: ${assurance.tier} (${assurance.reasonCodes.join(", ") || "bounded-runtime"}).`,
    ...proof,
    "Exact verifier commands:", verifier,
    ["Execution map (planning only):", ...criterionGraphGuidance(task.criterionGraph).map((line) => `- ${line}`)].join("\n"),
    RUNTIME_SOURCE_REUSE_GUIDANCE,
    "Root project instructions are loaded. Do not re-read root AGENTS.md or inspect Piagent/platform files; work directly in relevant source/tests with ordinary tools.",
    automaticTaskExecutionGuidance(task)
  ].join("\n");
  const taskBefore = JSON.stringify(task);
  const bounded = boundedRuntimeIntakeMessage(intake);
  const retainedHints = hints.filter((hint) => bounded.includes(hint));
  t.diagnostic(JSON.stringify({ inputChars: intake.length, outputChars: bounded.length,
    generatedHints: hints.length, retainedHints: retainedHints.length, ceilingChars: RUNTIME_INTAKE_MESSAGE_MAX_CHARS }));
  assert.equal(RUNTIME_INTAKE_MESSAGE_MAX_CHARS, 3500, "preservation must not increase the intake cap");
  assert.ok(intake.length > RUNTIME_INTAKE_MESSAGE_MAX_CHARS, "the real structured compaction path must execute");
  assert.ok(bounded.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS);
  assert.ok(hints.some((hint) => hint.includes("impossible calendar date")), "the semantic compiler must identify invalid date partitions");
  assert.ok(hints.some((hint) => hint.includes("explicitly supplied undefined")), "omission-sensitive requirements must be generated");
  assert.ok(hints.some((hint) => hint.includes("TypeError")));
  assert.ok(hints.some((hint) => hint.includes("numeric UTC offsets")), "valid input forms must also remain visible");
  const proofLines = proof.join("\n").split("\n");
  for (const hint of hints) {
    const taggedLine = proofLines.find((line) => line.endsWith(hint));
    assert.match(taggedLine ?? "", /^- \[(?:criterion-\d{2}|fallback)/);
    assert.ok(bounded.includes(taggedLine), `Compaction lost task-derived semantic proof or its criterion tag: ${taggedLine}`);
  }
  assert.ok(bounded.includes(verifier), "exact verification remains byte-preserved");
  assert.doesNotMatch(bounded, /Runtime intake refused:/, "this bounded contract must retain useful guidance, not become an oversized-contract refusal");
  assert.equal(JSON.stringify(task), taskBefore, "display compaction cannot mutate the durable contract or authority");
});

function compactStructuredProof(proofLines, { commands = ["npm test"], exactOutput } = {}) {
  const input = [
    "Piagent runtime task: CONTRACT-PROOF; initial focus (advisory): src/service.js, test/**.",
    "The complete operator request above is the authoritative acceptance contract.",
    "Assurance: rigorous (exact-behavior).",
    "Critical behavioral proof:", ...proofLines,
    "Candidate tags are locations, not proof; use linked live assertions.",
    ...(exactOutput ? [exactOutput] : []),
    "Exact verifier commands:",
    ...commands.map((command, index) => `Verifier ${index + 1} (run as an exact standalone shell command): ${command}`),
    "Execution map (planning only):",
    "- criterion-01 behavior @src/service.js proof=behavioral-check",
    "- criterion-02 behavior @src/service.js proof=behavioral-check",
    "Use runtime-delivered source; do not reread it.",
    "Follow the execution map and implement dependency-ready criteria."
  ].join("\n");
  assert.ok(input.length > 3500, "the metadata or proof body must require structured compaction");
  const output = boundedRuntimeIntakeMessage(input);
  assert.equal(RUNTIME_INTAKE_MESSAGE_MAX_CHARS, 3500);
  assert.ok(output.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS);
  return output;
}

const longCandidate = `packages/${"nested-library/".repeat(140)}test/service.test.mjs`;

test("compaction keeps distinct semantic bodies sharing the same long candidate metadata", () => {
  const bodies = [
    "Reject a fractional retry count with TypeError; integer coercion does not establish validity.",
    "Accept zero retries without executing a retry, while preserving the original error object."
  ];
  const output = compactStructuredProof(bodies.map((body) => `- [criterion-01:candidate=${longCandidate}] ${body}`));
  for (const body of bodies) assert.ok(output.includes(`- [criterion-01:candidate] ${body}`));
  assert.equal(output.split("[criterion-01:candidate]").length - 1, 2, "sharing a location must not deduplicate different obligations");
  assert.doesNotMatch(output, /Detailed semantic proof hints omitted/);
});

test("compaction deduplicates identical semantic bodies while retaining every originating criterion", () => {
  const body = "Preserve explicit false, zero, and empty-string settings instead of applying defaults.";
  const output = compactStructuredProof([
    `- [criterion-01:candidate=${longCandidate}] ${body}`,
    `- [criterion-02:fallback][criterion-01:candidate=${longCandidate}] ${body}`
  ]);
  assert.equal(output.split(body).length - 1, 1);
  const line = output.split("\n").find((entry) => entry.endsWith(body));
  assert.ok(line.includes("[criterion-01:candidate]"));
  assert.ok(line.includes("[criterion-02:fallback]"));
  assert.doesNotMatch(output, /Detailed semantic proof hints omitted/);
});

test("compaction preserves untagged bullet and plain semantic hints", () => {
  const body = "Keep equal-priority jobs in input order without mutating the supplied array.";
  const bullet = "Reject duplicate identifiers before scheduling any job.";
  const plain = "A successful empty schedule must return an empty array, not undefined.";
  const output = compactStructuredProof([
    `- [criterion-01:candidate=${longCandidate}] ${body}`,
    `- [criterion-02:candidate=${longCandidate}] ${body}`,
    `- ${bullet}`, plain
  ]);
  assert.ok(output.includes(`- ${bullet}`));
  assert.ok(output.includes(`- ${plain}`));
  assert.doesNotMatch(output, /Detailed semantic proof hints omitted/);
});

test("semantic compaction preserves exact final-output and verifier bytes including whitespace", () => {
  const body = "Observe the returned checkpoint before reconstructing application state.";
  const commands = ["  node   --test  'test/recovery flow.test.mjs'  ", "\tnpm run  lint\t"];
  const exactOutput = 'Exact final-output contract: End with exactly "  checked\tready  ".';
  const output = compactStructuredProof([
    `- [criterion-01:candidate=${longCandidate}] ${body}`,
    `- [criterion-02:candidate=${longCandidate}] ${body}`
  ], { commands, exactOutput });
  assert.equal(output.split(exactOutput).length - 1, 1, "the exact directive must not be truncated or duplicated");
  commands.forEach((command, index) => assert.ok(output.split("\n").includes(
    `Verifier ${index + 1} (run as an exact standalone shell command): ${command}`
  ), "leading, internal, and trailing command whitespace must remain unchanged"));
  assert.ok(output.includes(body));
  assert.doesNotMatch(output, /Runtime intake refused:|Detailed semantic proof hints omitted/);
});

test("genuine semantic overflow is explicitly labeled and cannot masquerade as preserved proof", () => {
  const body = `Each independently named transition requires its corresponding executable assertion. ${"bounded-transition-obligation ".repeat(160)}END-SEMANTIC-BODY`;
  const exactOutput = "Exact final-output contract: End with exactly CHECKED.";
  const command = "  npm run check  ";
  const output = compactStructuredProof([`- [criterion-01:fallback] ${body}`], { commands: [command], exactOutput });
  assert.match(output, /Detailed semantic proof hints omitted; consult the complete operator contract\./);
  assert.match(output, /\[criterion-01:fallback\]/);
  assert.equal(output.includes(body), false, "an over-budget body cannot be represented as fully retained");
  assert.equal(output.includes("END-SEMANTIC-BODY"), false, "do not disguise a partial semantic fragment as complete guidance");
  assert.ok(output.includes(exactOutput));
  assert.ok(output.includes(`Verifier 1 (run as an exact standalone shell command): ${command}`));
  assert.doesNotMatch(output, /Prove every tagged observable clause with linked durable live assertions|all semantic proof.*preserved/i);
});
