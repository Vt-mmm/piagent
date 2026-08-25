import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCriterionGraph,
  criterionGraphContextSelection,
  criterionGraphContextSelectionDetails,
  criterionGraphGuidance,
  criterionGraphMode,
  criterionGraphValidationErrors,
  normalizeCriterionGraph
} from "../packages/piagent-core/extensions/criterion-graph.js";

const createdAt = "2026-08-11T08:00:00.000Z";
const contract = {
  changeMode: "source-change",
  acceptanceCriteria: [
    "[C1] Update src/search.js without changing unrelated files.",
    "[C2] Reject invalid fractional limits with TypeError after [C1].",
    "[C3] The exact npm test verifier passes."
  ],
  scope: ["src/search.js", "test/search.test.js"],
  verifyCommands: ["npm test"]
};

test("criterion graph maps every operator criterion once without claiming satisfaction", () => {
  const graph = compileCriterionGraph({ ...contract, mode: "criterion-graph", createdAt });

  assert.equal(graph.mode, "criterion-graph");
  assert.deepEqual(graph.order, ["criterion-01", "criterion-02", "criterion-03"]);
  assert.deepEqual(graph.nodes.map((node) => node.obligation), contract.acceptanceCriteria);
  assert.deepEqual(graph.nodes.map((node) => node.criterionIndex), [0, 1, 2]);
  assert.equal(graph.nodes[0].kind, "scope");
  assert.equal(graph.nodes[1].kind, "boundary");
  assert.equal(graph.nodes[2].kind, "verification");
  assert.deepEqual(graph.nodes[1].dependsOn, ["criterion-01"]);
  assert.deepEqual(graph.nodes[2].dependsOn, ["criterion-01", "criterion-02"]);
  assert.deepEqual(graph.nodes[0].targetHints, ["src/search.js"]);
  assert.equal(Object.hasOwn(graph.nodes[0], "status"), false);
  assert.equal(Object.hasOwn(graph.nodes[0], "satisfied"), false);
  assert.deepEqual(criterionGraphValidationErrors(graph, contract), []);
});

test("criterion graph preserves behavioral proof for compound CSV criteria ending in verification", () => {
  const graph = compileCriterionGraph({
    changeMode: "source-change",
    acceptanceCriteria: [
      "Support quoted commas and escaped quotes, then run the configured verification.",
      "Return parsed CSV records as row arrays, then run the configured verification.",
      "Support quoted commas and escaped quotes, preserve parseCsv(input), throw SyntaxError for an unterminated quoted field, and run the configured verification."
    ],
    scope: ["src/data/csv.js", "test/**"],
    verifyCommands: ["npm test"],
    mode: "criterion-graph",
    createdAt
  });

  assert.deepEqual(graph.nodes.map((node) => node.kind), ["behavior", "output", "boundary"]);
  assert.ok(graph.nodes.every((node) => node.proofKinds.includes("behavioral-check")));
  assert.match(criterionGraphGuidance(graph)[2], /criterion-03 boundary .* proof=behavioral-check/);
});

test("criterion graph distinguishes verification-only clauses from substantive terminal verification", () => {
  const compile = (obligation, verifyCommands = ["npm test"]) => compileCriterionGraph({
    changeMode: "source-change",
    acceptanceCriteria: [obligation],
    scope: ["src/search.js", "test/search.test.js"],
    verifyCommands,
    mode: "criterion-graph",
    createdAt
  }).nodes[0];

  for (const obligation of [
    "All focused tests pass.",
    "All focused tests must pass.",
    "The error handling tests pass.",
    "The output snapshot tests should pass.",
    "The configured verifier shall pass.",
    "Must run all verification commands.",
    "`npm test` must pass.",
    "Run `npm test` on the final tree."
  ]) {
    const node = compile(obligation);
    assert.equal(node.kind, "verification", obligation);
    assert.deepEqual(node.proofKinds, ["exact-verifier"]);
  }

  const compound = compile("Normalize Unicode queries correctly and lint passes.");
  assert.equal(compound.kind, "behavior");
  assert.deepEqual(compound.proofKinds, ["behavioral-check", "exact-verifier"]);

  const exactCompound = compile("Normalize Unicode queries correctly, then `npm test` should pass.");
  assert.equal(exactCompound.kind, "behavior");
  assert.deepEqual(exactCompound.proofKinds, ["behavioral-check", "exact-verifier"]);

  for (const obligation of [
    "`npm run imaginary` must pass.",
    "The exact `npm run imaginary` verifier shall pass.",
    "`parseCsv(input)` should pass."
  ]) {
    const node = compile(obligation);
    assert.equal(node.kind, "behavior", obligation);
    assert.deepEqual(node.proofKinds, ["behavioral-check", "exact-verifier"]);
  }

  assert.equal(compile("`npm run lint` shall pass.", ["npm test", "npm run lint"]).kind, "verification");
  assert.equal(compile("Run npm test.").kind, "verification");
  assert.equal(compile("`NPM TEST` must pass.").kind, "behavior", "configured shell commands remain case-sensitive");

  for (const obligation of [
    "Run npm test.",
    "Execute yarn tests.",
    "Run no tests."
  ]) {
    assert.equal(compile(obligation, ["npm run verify"]).kind, "behavior", obligation);
  }

  assert.equal(compile("Only touch src/search.js and all focused tests pass.").kind, "scope");
  assert.equal(compile("Reject malformed queries and all focused tests must pass.").kind, "boundary");
  assert.equal(compile("Return normalized output, then `npm test` shall pass.").kind, "output");
});

test("criterion graph is deterministic, task-bound, and keeps an explicit mechanical kill switch", () => {
  const first = compileCriterionGraph({ ...contract, mode: "criterion-graph", createdAt });
  const second = compileCriterionGraph({ ...contract, mode: "criterion-graph", createdAt: "2026-08-11T09:00:00.000Z" });
  assert.equal(first.graphDigest, second.graphDigest);
  assert.equal(first.criterionDigest, second.criterionDigest);

  assert.equal(criterionGraphMode(undefined), "criterion-graph");
  const mechanical = compileCriterionGraph({ ...contract, mode: criterionGraphMode("off"), createdAt });
  assert.equal(mechanical.mode, "mechanical");
  assert.ok(mechanical.nodes.every((node) => node.targetHints.length === 0));
  assert.deepEqual(criterionGraphGuidance(mechanical), []);
  assert.match(criterionGraphGuidance(first)[1], /criterion-02 boundary @src\/search\.js,test\/search\.test\.js proof=behavioral-check after=criterion-01/);

  const changed = compileCriterionGraph({
    ...contract,
    acceptanceCriteria: [...contract.acceptanceCriteria.slice(0, 2), "A different verifier passes."],
    mode: "criterion-graph",
    createdAt
  });
  assert.notEqual(first.criterionDigest, changed.criterionDigest);
  assert.notEqual(first.graphDigest, changed.graphDigest);
});

test("criterion graph validation fails closed on omission, duplication, stale criteria, and injected proof state", () => {
  const graph = compileCriterionGraph({ ...contract, mode: "criterion-graph", createdAt });
  const cases = [
    { ...graph, nodes: graph.nodes.slice(0, 2), order: graph.order.slice(0, 2) },
    { ...graph, nodes: [graph.nodes[0], graph.nodes[0], graph.nodes[2]] },
    { ...graph, nodes: graph.nodes.map((node, index) => index === 1 ? { ...node, obligation: "stale" } : node) },
    { ...graph, nodes: graph.nodes.map((node, index) => index === 1 ? { ...node, status: "satisfied" } : node) },
    { ...graph, graphDigest: "0".repeat(64) }
  ];
  for (const value of cases) assert.ok(criterionGraphValidationErrors(value, contract).length > 0);
});

test("normalization strips unknown nested fields and read-only graphs require observed evidence", () => {
  const readOnly = compileCriterionGraph({
    acceptanceCriteria: ["Report the exact cited configuration."],
    scope: ["config.json"],
    verifyCommands: [],
    changeMode: "read-only",
    mode: "criterion-graph",
    createdAt
  });
  assert.equal(readOnly.nodes[0].kind, "investigation");
  assert.deepEqual(readOnly.nodes[0].proofKinds, ["read-evidence"]);

  const normalized = normalizeCriterionGraph({
    ...readOnly,
    privateState: true,
    nodes: [{ ...readOnly.nodes[0], satisfied: true }]
  });
  assert.equal(Object.hasOwn(normalized, "privateState"), false);
  assert.equal(Object.hasOwn(normalized.nodes[0], "satisfied"), false);
});

test("context selection resolves only graph-scoped project files and preserves bounded observed context", () => {
  const graph = compileCriterionGraph({
    ...contract,
    scope: ["src/**", "test/search.test.js"],
    mode: "criterion-graph",
    createdAt
  });
  const selected = criterionGraphContextSelection(
    graph,
    ["src/search.js", "src/other.js", "test/search.test.js", ".pi/private.json"],
    [{ path: "README.md", reason: "already observed" }, { path: "src/search.js", reason: "duplicate observation" }],
    4
  );
  assert.deepEqual(selected.map((entry) => entry.path), ["src/search.js", "src/other.js", "test/search.test.js", "README.md"]);
  assert.match(selected[0].reason, /^criterion-/);
  assert.equal(selected.some((entry) => entry.path === ".pi/private.json"), false);
  const truncated = criterionGraphContextSelectionDetails(
    graph,
    ["src/search.js", "src/other.js", "test/search.test.js"],
    [{ path: "README.md", reason: "already observed" }],
    2
  );
  assert.equal(truncated.entries.length, 2);
  assert.equal(truncated.complete, false);
  assert.equal(truncated.candidateCount, 4);
  const incompleteInput = criterionGraphContextSelectionDetails(
    graph,
    ["src/search.js", "test/search.test.js"],
    [],
    8,
    false
  );
  assert.equal(incompleteInput.complete, false);
  assert.equal(incompleteInput.candidateCount, 2);
  const wideScope = ["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.js", "test/b.test.js"];
  const wideGraph = compileCriterionGraph({
    ...contract,
    acceptanceCriteria: ["Preserve malformed-input behavior and add durable coverage."],
    scope: wideScope,
    mode: "criterion-graph",
    createdAt
  });
  assert.equal(wideGraph.nodes[0].targetHints.length, 4, "the graph keeps its bounded navigation hints");
  const scopeTruncated = criterionGraphContextSelectionDetails(wideGraph, wideScope, [], 8, true, wideScope);
  assert.equal(scopeTruncated.complete, false, "omitted task-scope files prevent a false singleton proof");
  assert.equal(scopeTruncated.entries.some((entry) => entry.path === "test/b.test.js"), false);
  const overflowScope = ["test/a.test.js", ...Array.from({ length: 1999 }, (_, index) => `src/f${index}.js`), "test/b.test.js"];
  const overflowGraph = { mode: "criterion-graph", nodes: [{ id: "criterion-01", kind: "behavior", targetHints: ["test/a.test.js"] }] };
  const scopeOverflow = criterionGraphContextSelectionDetails(overflowGraph, ["test/a.test.js", "test/b.test.js"], [], 8, true, overflowScope);
  assert.equal(scopeOverflow.complete, false, "a 2001st scope entry cannot be truncated into false completeness");
  const sourceOnlyGraph = { mode: "criterion-graph", nodes: [{ id: "criterion-01", kind: "behavior", targetHints: ["src/foo.js"] }] };
  const scopedFiles = ["src/foo.js", "tests/a.test.js", "tests/b.test.js"];
  const directoryScope = criterionGraphContextSelectionDetails(sourceOnlyGraph, scopedFiles, [], 8, true, ["src/foo.js", "tests"]);
  assert.equal(directoryScope.complete, false, "an omitted directory subtree prevents false completeness");
  for (const pattern of ["tests/{a,b}.test.js", "tests/[ab].test.js"]) {
    const unsupportedGlob = criterionGraphContextSelectionDetails(sourceOnlyGraph, scopedFiles, [], 8, true, ["src/foo.js", pattern]);
    assert.equal(unsupportedGlob.complete, false, `${pattern} must fail closed until its glob semantics are proved`);
  }
  assert.deepEqual(criterionGraphContextSelection({ ...graph, mode: "mechanical" }, ["src/search.js"], [{ path: "README.md", reason: "observed" }], 8), [
    { path: "README.md", reason: "observed" }
  ]);
});

test("unmatched criteria leave broad test globs as planning scope rather than proof", () => {
  const graph = compileCriterionGraph({
    changeMode: "source-change",
    acceptanceCriteria: ["Support every requested argument syntax."],
    scope: ["src/platform/args.js", "test/**", "tests/**"],
    verifyCommands: ["npm test"],
    mode: "criterion-graph",
    createdAt
  });

  assert.deepEqual(graph.nodes[0].targetHints, ["src/platform/args.js", "test/**", "tests/**"]);
});
