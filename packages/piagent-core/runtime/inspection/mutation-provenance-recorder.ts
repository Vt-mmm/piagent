import { currentFileContentDigests } from "../quality/model-mutation-proof.ts";
import type { ModelMutationEvidenceCompletion, ModelMutationIdentity } from "../session/model-authorship-state.ts";
import { appendMutationProvenance, type AppendMutationProvenanceOptions } from "./mutation-provenance-store.ts";

type RecordMutationResultOptions = {
  projectRoot: string;
  identity: ModelMutationIdentity;
  toolCallId: string;
  toolName: string;
  recordedAt: string;
  successful: boolean;
  currentSnapshot: Record<string, string>;
  completion: ModelMutationEvidenceCompletion;
  shellSnapshotBefore?: Record<string, string>;
  shellChangedPaths: string[];
  protectedPaths: string[];
};

function toolName(value: string): AppendMutationProvenanceOptions["toolName"] {
  const normalized = value.toLowerCase();
  if (normalized === "edit" || normalized === "write" || normalized === "apply_patch") return normalized;
  if (["bash", "shell", "exec"].includes(normalized)) return "shell";
  return "opaque";
}

export function recordMutationResult(options: RecordMutationResultOptions) {
  if (!options.successful) return undefined;
  const changedPaths = [...new Set([...options.completion.changedPaths, ...options.shellChangedPaths])].sort();
  const beforeSnapshot = options.completion.beforeSnapshot ?? options.shellSnapshotBefore;
  if (!beforeSnapshot || changedPaths.length === 0) return undefined;
  const contentDigests = currentFileContentDigests(options.projectRoot, changedPaths);
  return appendMutationProvenance({
    projectRoot: options.projectRoot,
    taskId: options.identity.taskId,
    taskRunId: options.identity.taskRunId,
    sessionId: options.identity.sessionId,
    toolCallId: options.toolCallId,
    toolName: toolName(options.toolName),
    recordedAt: options.recordedAt,
    beforeSnapshot,
    afterSnapshot: options.currentSnapshot,
    changedPaths,
    recordedDigests: options.completion.recordedDigests,
    recordedContentDigests: { ...contentDigests, ...options.completion.recordedContentDigests },
    proofModes: options.completion.proofModes,
    protectedPaths: options.protectedPaths
  });
}
