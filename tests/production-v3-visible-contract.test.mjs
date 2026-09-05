import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { automaticAcceptanceCriteria } from "../packages/piagent-core/runtime/workflows/task-intake.ts";
import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";

const root = path.resolve(import.meta.dirname, "..");
const suiteRoot = path.join(root, "benchmarks/production-v3");
const suite = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.json"), "utf8"));
const grader = fs.readFileSync(path.join(suiteRoot, "grade.mjs"), "utf8");
const normalize = text => text.replaceAll("`", "").replace(/\s+/g, " ").trim();

// These are disclosure checks, not a substitute for independent semantic grader tests.
// Keep each requirement bound to its own scenario and strict grader assertion.
const contracts = [
  {
    scenarioId: "resumable-checkpoint-partial-failure",
    check: "checkpoint-validation",
    graderFragments: [
      "assert.rejects(resumeWork(data.items, { nextIndex: 2, results: [] }, async () => null), TypeError)",
      "assert.rejects(resumeWork(data.items, { nextIndex: -1, results: [] }, async () => null), TypeError)",
      "assert.rejects(resumeWork(data.items, null, async () => null), TypeError)"
    ],
    requirements: [
      /checkpoint must be a non-null, non-array object/i,
      /with integer nextIndex in the inclusive range 0\.\.items\.length/i,
      /an array results satisfying results\.length === nextIndex/i,
      /reject malformed shapes, negative or out-of-range indices, and results length mismatches with TypeError/i
    ]
  },
  {
    scenarioId: "chunked-record-boundary",
    check: "stream-input-and-encoding-validation",
    graderFragments: ['assert.throws(() => parseNdjsonChunks(["not-bytes"]), TypeError)'],
    requirements: [
      /reject any non-Uint8Array chunk with TypeError/i
    ]
  },
  {
    scenarioId: "pagination-boundary",
    check: "invalid-pagination-rejected",
    graderFragments: ["assert.throws(() => clampPage(1.2, 10, 5), TypeError)"],
    requirements: [
      /clampPage must reject a non-integer page with TypeError; do not round or coerce it/i
    ]
  },
  {
    scenarioId: "reconnect-chat-event-order",
    check: "conflicting-confirmed-message-rejected",
    graderFragments: ['eventId: "two", kind: "message", messageId: "same"', "]), /conflict/i)"],
    requirements: [
      /conflicting confirmed content must throw an error containing conflict \(case-insensitive\)/i
    ]
  },
  {
    scenarioId: "backend-frontend-contract-sync",
    check: "contract-drift-is-complete-and-sorted",
    graderFragments: [
      "fields: [...backend.requiredFields]",
      "missingFields: [backend.requiredFields[data.omittedFieldIndex]]"
    ],
    requirements: [
      /backend has required properties version, statuses, and requiredFields/i,
      /frontend has required properties version, statuses, and fields/i,
      /Both versions must be positive integers/i,
      /backend\.statuses, frontend\.statuses, backend\.requiredFields, and frontend\.fields must be arrays of unique non-empty strings/i,
      /Compare backend\.requiredFields against frontend\.fields/i,
      /reject malformed contracts or duplicate declarations with TypeError/i
    ]
  },
  {
    scenarioId: "idempotent-replay-conflict",
    check: "conflict-is-atomic-and-input-is-validated",
    graderFragments: ['eventId: "", entityId: data.entityA, expectedVersion: 2, nextValue: "x" }]), TypeError)'],
    requirements: [
      /a unique non-empty string eventId, a non-empty string entityId/i,
      /reject malformed state or event shapes, including empty IDs, with TypeError/i
    ]
  }
];

function graderBranch(scenarioId) {
  const start = grader.indexOf(`  case "${scenarioId}":`);
  assert.notEqual(start, -1, `missing grader branch: ${scenarioId}`);
  const next = grader.indexOf("\n  case ", start + 1);
  return grader.slice(start, next === -1 ? grader.indexOf("\n  default:", start) : next);
}

function missingRequirements(contract, text) {
  return contract.requirements.filter(requirement => !requirement.test(normalize(text)));
}

for (const contract of contracts) {
  test(`production-v3 discloses the strict ${contract.scenarioId} contract`, () => {
    const scenario = suite.scenarios.find(value => value.id === contract.scenarioId);
    assert.ok(scenario, `scenario is not in the actual suite: ${contract.scenarioId}`);
    assert.ok(scenario.userJourney.turns.some(turn => turn.prompt === scenario.prompt),
      "the clarified prompt must actually be delivered in the model-visible journey");
    const branch = graderBranch(contract.scenarioId);
    assert.ok(branch.includes(`check("${contract.check}"`), "strict grader check changed; review the mapping");
    for (const fragment of contract.graderFragments) {
      assert.ok(branch.includes(fragment), `strict grader assertion changed: ${fragment}`);
    }
    const prompt = fs.readFileSync(path.join(suiteRoot, scenario.prompt), "utf8");
    assert.deepEqual(missingRequirements(contract, prompt).map(String), [],
      "model-visible contract must disclose every mapped requirement");

    // Removing any required domain/class/schema clause must be detected even when
    // unrelated TypeError or field names remain elsewhere in the same prompt.
    for (const requirement of contract.requirements) {
      const omitted = normalize(prompt).replace(requirement, "[omitted contract clause]");
      assert.ok(missingRequirements(contract, omitted).includes(requirement));
    }
  });
}

for (const [scenarioId, expectedCount] of [
  ["resumable-checkpoint-partial-failure", 11], ["backend-frontend-contract-sync", 9]
]) {
  test(`production-v3 ${scenarioId} keeps atomic runtime acceptance criteria`, () => {
    const scenario = suite.scenarios.find(value => value.id === scenarioId);
    const prompt = fs.readFileSync(path.join(suiteRoot, scenario.prompt), "utf8");
    const automatic = automaticAcceptanceCriteria(prompt, "source-change", "required");
    assert.equal(automatic.length, expectedCount);
    assert.ok(automatic.length > 1 && automatic.length <= 12);
    assert.ok(automatic.every(text => !text.includes("\n")),
      "contract disclosure must not newly trigger grouped compound fallback");
    const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change",
      summary: prompt, acceptanceCriteria: automatic });
    assert.deepEqual(built.acceptanceCriteria, automatic, "receipt preserves every atomic criterion");
    const verifier = "The configured verification command passes after the final mutation.";
    assert.equal(automatic.at(-1), verifier);
    assert.equal(normalize(automatic.slice(0, -1).join(" ")), normalize(prompt),
      "bounded atomic intake must retain the complete model-visible contract");
    const invalidInput = built.receipt.criteria.filter((criterion, index) =>
      /TypeError/.test(built.acceptanceCriteria[index]));
    assert.ok(invalidInput.length > 0, "explicit exception class must remain represented");
    for (const criterion of invalidInput) {
      assert.equal(criterion.obligation, "invalid-input-rejection");
      assert.equal(criterion.priority, "critical");
    }
    assert.ok(built.receipt.criteria.every(criterion => criterion.status === "pending"),
      "compilation alone never grants acceptance assurance");
  });
}

test("production-v3 visible-contract audit covers all 27 actual scenarios exactly once", () => {
  const journal = fs.readFileSync(path.join(root, "docs/journals/run5-contract-audit-20260905.md"), "utf8");
  const audited = [...journal.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  assert.equal(suite.scenarios.length, 27);
  assert.equal(new Set(audited).size, 27);
  assert.equal(audited.length, 27);
  assert.deepEqual(audited.toSorted(), suite.scenarios.map(scenario => scenario.id).toSorted());
  assert.match(journal, /run-5.*not regraded/i);
  assert.match(journal, /not a human-review waiver/i);
});
