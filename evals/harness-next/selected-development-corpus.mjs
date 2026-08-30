import { createHash } from "node:crypto";
import { developmentCorpus } from "./development-corpus.mjs";
import { compileContractSelection } from "../../packages/piagent-core/extensions/acceptance-contract-selection.js";

// Development labels are deliberately reused, never promoted to held-out data.
// Selection/expectation compilation has no candidate-source or output input.
export function selectedDevelopmentCorpus(libraryText, backend) {
  const families = {
    "pure-function": ["finite-list-sum", { call: "run" }],
    "temporal-input": ["deadline-status", { call: "run" }],
    "configuration-precedence": ["defined-config-precedence", { call: "run", numericKey: "limit", booleanKey: "enabled", textKey: "label" }],
    "stateful-recovery": ["idempotent-accumulator-checkpoint", { apply: "apply", snapshot: "snapshot", restore: "restore", read: "read" }]
  };
  const original = developmentCorpus(), rows = original.rows.map((row) => {
    const [id, parameters] = families[row.domain], text = `Development contract: ${id}`;
    const preview = compileContractSelection({ libraryText,
      taskText: JSON.stringify({ operatorRequestDigest: `operator-request-v1:${"a".repeat(64)}`, acceptanceCriteria: [text],
        acceptanceReceipt: { criteria: [{ id: "development", hash: createHash("sha256").update(text).digest("hex"), obligation: "requested-behavior" }] } }),
      recipeText: JSON.stringify({ schemaVersion: 1, backend, selections: [{ criterion: { text, obligation: "requested-behavior" },
        family: { id, version: 1 }, parameters, sourcePath: "candidate.js", maxAttempts: 1 }] })
    });
    if (preview.status !== "preview-only" || !preview.plan || preview.unselectedCriteria.length) throw new Error("Development contract selection failed");
    const contract = preview.plan.contracts[0];
    return { ...row, selection: contract.selection, plan: { schemaVersion: 1, source: row.plan.source, exportName: contract.exportName, checks: contract.checks } };
  });
  return { ...original, id: "harness-next-selected-development-v1", rows };
}
