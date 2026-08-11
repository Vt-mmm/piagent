import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCriterionGraph,
  criterionGraphContextSelection,
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
  assert.deepEqual(criterionGraphContextSelection({ ...graph, mode: "mechanical" }, ["src/search.js"], [{ path: "README.md", reason: "observed" }], 8), [
    { path: "README.md", reason: "observed" }
  ]);
});
