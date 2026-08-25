import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceLanguageAdapterForPath, isAcceptanceTestPath } from "../packages/piagent-core/extensions/acceptance-language-adapters.js";
import {
  behavioralCriterionProofGuidance,
  concretePlannedAcceptanceTests,
  criticalProofSection
} from "../packages/piagent-core/runtime/registration/task-start-guidance.ts";

const projectFiles = [
  "src/search.js",
  "test/search.test.js",
  "tests/range.test.ts",
  "tests/unmentioned.test.mjs",
  "tests/verify-only.test.js",
  "tests/types.test.d.ts",
  "tests/data.json",
  "tests/README.md",
  "tests/result.snap"
];

const plannedContext = projectFiles.map((path) => ({ path, reason: "criterion target" }));

const criterionGraph = {
  nodes: [
    {
      id: "criterion-01",
      obligation: "Reject fractional values and cover them in test/search.test.js.",
      kind: "boundary",
      proofKinds: ["behavioral-check", "exact-verifier"],
      targetHints: ["src/search.js", "test/**"]
    },
    {
      id: "criterion-02",
      obligation: "Exercise zero and negative values in `range.test.ts`.",
      kind: "boundary",
      proofKinds: ["behavioral-check", "exact-verifier"],
      targetHints: ["src/search.js", "tests/**"]
    },
    {
      id: "criterion-03",
      obligation: "Do not infer proof from tests/data.json, tests/README.md, tests/result.snap, or tests/types.test.d.ts fixtures.",
      kind: "behavior",
      proofKinds: ["behavioral-check", "exact-verifier"],
      targetHints: ["tests/**"]
    },
    {
      id: "criterion-04",
      obligation: "The exact verifier tests/verify-only.test.js passes.",
      kind: "verification",
      proofKinds: ["exact-verifier"],
      targetHints: ["tests/verify-only.test.js"]
    }
  ]
};

test("focused test candidates require an explicitly named executable JS/TS behavioral test", () => {
  const candidates = concretePlannedAcceptanceTests(
    plannedContext,
    projectFiles,
    criterionGraph,
    isAcceptanceTestPath,
    acceptanceLanguageAdapterForPath
  );

  assert.deepEqual(candidates, [
    { criterionId: "criterion-01", path: "test/search.test.js" },
    { criterionId: "criterion-02", path: "tests/range.test.ts" }
  ]);
  assert.equal(candidates.some((candidate) => /(?:json|README\.md|snap|\.d\.ts)$/.test(candidate.path)), false);
  assert.equal(candidates.some((candidate) => candidate.path === "tests/verify-only.test.js"), false);
});

test("critical proof maps each item only to its criterion candidate and gives unmatched items a fallback", () => {
  const candidates = concretePlannedAcceptanceTests(
    plannedContext,
    projectFiles,
    criterionGraph,
    isAcceptanceTestPath,
    acceptanceLanguageAdapterForPath
  );
  const criterionProofs = [
    { criterionId: "criterion-01", guidance: ["Reject fractional values."] },
    { criterionId: "criterion-02", guidance: ["Exercise zero and negative values."] },
    { criterionId: "criterion-03", guidance: ["Assert TypeError for malformed input."] }
  ];
  const section = criticalProofSection([
    "Reject fractional values.",
    "Exercise zero and negative values.",
    "Assert TypeError for malformed input.",
    "Prove a global cross-criterion invariant."
  ], candidates, criterionProofs).join("\n");

  const fractionalLine = section.split("\n").find((line) => line.includes("Reject fractional values"));
  const rangeLine = section.split("\n").find((line) => line.includes("Exercise zero and negative values"));
  assert.match(fractionalLine, /^- \[criterion-01:candidate=test\/search\.test\.js\]/);
  assert.doesNotMatch(fractionalLine, /range\.test\.ts/);
  assert.match(rangeLine, /^- \[criterion-02:candidate=tests\/range\.test\.ts\]/);
  assert.doesNotMatch(rangeLine, /search\.test\.js/);
  assert.match(section, /^- \[criterion-03:fallback\] Assert TypeError/m);
  assert.match(section, /^- \[fallback\] Prove a global cross-criterion invariant/m);
  assert.match(section, /Candidate tags are locations, not proof/);
  assert.match(section, /live assertions and changed-test evidence/);
  assert.match(section, /Each fallback tag requires adding\/updating a durable scoped focused test with live assertions/);
  assert.match(section, /test scope is unavailable, report missing durable proof and do not claim completion/);
  assert.match(section, /after the criterion's final intended mutation and before exact verifiers/i);
  assert.match(section, /later target mutation or a runtime-authorized same-tree infrastructure retry/);
  assert.doesNotMatch(section, /assertion matrix/);
  assert.doesNotMatch(section, /No concrete criterion-linked focused test was selected/);
});

test("criterion proof derivation stays attached to the originating behavioral criterion", () => {
  const derived = behavioralCriterionProofGuidance(criterionGraph, (text) => (
    text.includes("fractional") ? ["fractional-proof"]
      : text.includes("zero") ? ["range-proof"] : []
  ));
  assert.deepEqual(derived, [
    { criterionId: "criterion-01", guidance: ["fractional-proof"] },
    { criterionId: "criterion-02", guidance: ["range-proof"] },
    { criterionId: "criterion-03", guidance: [] }
  ]);
});

test("behavioral criteria always receive a focused-proof fallback when semantic hints abstain", () => {
  const graph = {
    nodes: [{
      id: "criterion-01",
      obligation: "Support each named observable input form.",
      kind: "behavior",
      proofKinds: ["behavioral-check", "exact-verifier"],
      targetHints: ["src/args.js"]
    }]
  };
  const criterionProofs = behavioralCriterionProofGuidance(graph, () => []);
  const section = criticalProofSection([], [], criterionProofs).join("\n");

  assert.match(section, /Critical behavioral proof/);
  assert.match(section, /\[criterion-01:fallback\].*every tagged observable clause/);
  assert.match(section, /generic verifier alone is insufficient/);
  assert.match(section, /never claim unproved behavior/);
});
