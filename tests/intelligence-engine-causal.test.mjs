import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCriterionGraph,
  criterionGraphContextSelection,
  criterionGraphGuidance,
  criterionGraphValidationErrors
} from "../packages/piagent-core/extensions/criterion-graph.js";
import { piagentTreatment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";

const input = {
  acceptanceCriteria: [
    "Update src/search.js while preserving input order.",
    "Reject invalid negative and fractional limits with TypeError.",
    "Only src/search.js and test/search.test.js may change.",
    "The exact npm test verifier passes."
  ],
  scope: ["src/search.js", "test/search.test.js"],
  verifyCommands: ["npm test"],
  changeMode: "source-change",
  createdAt: "2026-08-11T08:00:00.000Z"
};

test("provider-free causal arms preserve task truth while the engine selects relevant context", () => {
  const mechanical = compileCriterionGraph({ ...input, mode: "mechanical" });
  const engine = compileCriterionGraph({ ...input, mode: "criterion-graph" });
  const files = ["docs/old.md", "src/unrelated.js", "README.md", "src/search.js", "test/search.test.js"];
  const observed = files.slice(0, 3).map((path) => ({ path, reason: "prior broad observation" }));
  const baselineContext = criterionGraphContextSelection(mechanical, files, observed, 3);
  const engineContext = criterionGraphContextSelection(engine, files, observed, 3);

  assert.equal(engine.criterionDigest, mechanical.criterionDigest, "both arms bind the exact same Task Contract truth");
  assert.deepEqual(engine.nodes.map((node) => node.obligation), mechanical.nodes.map((node) => node.obligation));
  assert.deepEqual(criterionGraphValidationErrors(engine, input), []);
  assert.deepEqual(baselineContext.map((entry) => entry.path), ["docs/old.md", "src/unrelated.js", "README.md"]);
  assert.deepEqual(engineContext.map((entry) => entry.path), ["src/search.js", "test/search.test.js", "docs/old.md"]);
  assert.equal(baselineContext.filter((entry) => input.scope.includes(entry.path)).length, 0);
  assert.equal(engineContext.filter((entry) => input.scope.includes(entry.path)).length, 2);
  assert.ok(criterionGraphGuidance(engine).join("\n").length < 600);
  assert.equal(criterionGraphGuidance(mechanical).length, 0, "the control adds no model-facing graph text");
});

test("causal benchmark arms differ by one immutable intelligence switch", () => {
  const mechanical = piagentTreatment("mechanical-core").environment;
  const engine = piagentTreatment("intelligence-engine").environment;
  assert.deepEqual(Object.keys({ ...mechanical, ...engine }).filter((key) => mechanical[key] !== engine[key]), ["PIAGENT_INTELLIGENCE_ENGINE"]);
  assert.equal(mechanical.PIAGENT_INTELLIGENCE_ENGINE, "off");
  assert.equal(engine.PIAGENT_INTELLIGENCE_ENGINE, "on");
});

test("twelve long criteria remain bounded and cyclic forward references cannot enter the execution order", () => {
  const acceptanceCriteria = Array.from({ length: 12 }, (_entry, index) => (
    `[C${index + 1}] Preserve bounded behavior ${"detail ".repeat(60)}tail-${index + 1}${index === 0 ? " after [C12]" : ""}.`
  ));
  const graph = compileCriterionGraph({ ...input, acceptanceCriteria, mode: "criterion-graph" });
  assert.equal(graph.nodes.length, 12);
  assert.deepEqual(graph.nodes[0].dependsOn, [], "forward references are guidance, not executable dependency truth");
  assert.ok(criterionGraphGuidance(graph).join("\n").length < 1_600);
  assert.deepEqual(criterionGraphValidationErrors(graph, { ...input, acceptanceCriteria }), []);
});
