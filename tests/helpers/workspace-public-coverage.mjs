import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import assert from "node:assert/strict";
import { data } from "./async-contract-cases.mjs";

// Existing public workspace-order witnesses, scoped to each actual request
// criterion. These finite checks do not claim universal graph correctness.
const returns = (id, input, value) => ({ id, args: [data(input)], invocation: { kind: "call" }, observeArgs: true,
  expected: { outcome: "return", value: data(value), argsAfter: [data(input)] } });
const cycle = (id, input) => ({ id, args: [data(input)], invocation: { kind: "call" }, observeArgs: true,
  observeErrorMessage: true, expected: { outcome: "throw", errorClass: "Error",
    errorMessage: { includes: "cycle", ignoreCase: false }, argsAfter: [data(input)] } });
export function workspaceCoveredContracts(criteria) {
  assert.equal(criteria.length, 8);
  const anchors = ["Fix dependency ordering", "Return every workspace package exactly once",
    "Ignore dependency names", "Preserve input order", "Throw an `Error` containing `cycle`", "Do not mutate input."];
  anchors.forEach((text, i) => assert.ok(criteria[i].criterionText.startsWith(text)));
  const dependency = [returns("dependency-before-dependent", [{ name: "app", dependencies: ["ui", "core", "core"] },
    { name: "ui", dependencies: ["core"] }, { name: "core" }], ["core", "ui", "app"]),
    returns("shared-once", [{ name: "first", dependencies: ["shared"] }, { name: "second", dependencies: ["shared"] },
      { name: "shared" }], ["shared", "first", "second"])];
  const independent = [returns("external-ignored-input-order", [{ name: "z", dependencies: ["external"] },
    { name: "a" }, { name: "m", dependencies: [] }], ["z", "a", "m"]), returns("empty", [], [])];
  const cycles = [cycle("self-cycle", [{ name: "self", dependencies: ["self"] }]),
    cycle("indirect-cycle", [{ name: "a", dependencies: ["b"] }, { name: "b", dependencies: ["c"] },
      { name: "c", dependencies: ["a"] }])];
  const all = [...dependency, ...independent, ...cycles,
    returns("inputs-unchanged", [{ name: "app", dependencies: ["lib"] }, { name: "lib" }], ["lib", "app"])];
  return addPublicApiCoverage([all, dependency, independent, independent, cycles, all].map((cases, i) => ({ route: "code",
    criterionId: criteria[i].criterionId, criterionHash: criteria[i].criterionHash,
    sourcePath: "src/platform/workspace.js", exportName: "workspaceOrder", maxAttempts: 1,
    checks: [{ id: `workspace-public-criterion-${i + 1}`, cases }] })));
}
