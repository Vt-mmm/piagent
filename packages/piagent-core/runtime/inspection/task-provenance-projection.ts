import {
  decodeMutationRepoPath,
  type MutationProvenanceRecord
} from "./mutation-provenance-contract.ts";
import { readMutationProvenance } from "./mutation-provenance-store.ts";
import { taskBaselineManifestRef } from "./source-evidence-store.ts";
import type { TaskBaselineEntry, TaskBaselineManifest } from "./source-evidence-contract.ts";

export type SourceProvenance = {
  classification: "runtime-observed-agent" | "post-baseline-unattributed" | "mixed";
  evidence: "exact" | "unavailable";
  baselineEvidenceRef: string | null;
  mutationEvidenceRefs: string[];
  reasonCode: string | null;
};

type ExactState = { contentDigest: string; evidenceRefs: string[] };

function paths(record: MutationProvenanceRecord): Array<{ path: string; index: number }> {
  const result: Array<{ path: string; index: number }> = [];
  for (let index = 0; index < record.changes.length; index += 1) {
    const decoded = decodeMutationRepoPath(record.changes[index]);
    if (decoded) result.push({ path: decoded, index });
  }
  return result;
}

export function taskProvenanceResolver(projectRoot: string, manifest: TaskBaselineManifest) {
  const ledger = readMutationProvenance(projectRoot, manifest.taskRunId);
  const exact = new Map<string, ExactState>();
  if (ledger.corruptions.length === 0) {
    for (const record of ledger.records) {
      for (const item of paths(record)) {
        const change = record.changes[item.index];
        const current = exact.get(item.path);
        if (record.evidenceMode === "exact-runtime" && change.afterContentDigest) {
          exact.set(item.path, {
            contentDigest: change.afterContentDigest,
            evidenceRefs: [...new Set([...(current?.evidenceRefs ?? []), record.evidenceRef])].slice(-64)
          });
        } else if (!(change.effect === "content-preserved" && current
          && change.afterContentDigest === current.contentDigest)) {
          exact.delete(item.path);
        }
      }
    }
  }
  return (projectPath: string, currentContentDigest: string | null, baselineEntry?: TaskBaselineEntry): SourceProvenance => {
    const state = exact.get(projectPath);
    if (!state || !currentContentDigest || state.contentDigest !== currentContentDigest) {
      return {
        classification: "post-baseline-unattributed", evidence: "unavailable", baselineEvidenceRef: null,
        mutationEvidenceRefs: [], reasonCode: ledger.corruptions.length ? "provenance-ledger-corrupt" : "provenance-evidence-unavailable"
      };
    }
    return baselineEntry
      ? { classification: "mixed", evidence: "exact", baselineEvidenceRef: taskBaselineManifestRef(manifest), mutationEvidenceRefs: state.evidenceRefs, reasonCode: null }
      : { classification: "runtime-observed-agent", evidence: "exact", baselineEvidenceRef: null, mutationEvidenceRefs: state.evidenceRefs, reasonCode: null };
  };
}
