export function conditionalMutationPreTaskContext<ContextEntry extends { path?: string }>(
  context: ContextEntry[],
  scope: string[],
  enabled: boolean,
  matchesAnyPath: (candidate: string, patterns: string[]) => boolean
): ContextEntry[] {
  if (!enabled) return context;
  return context.filter((item) => typeof item.path === "string" && matchesAnyPath(item.path, scope));
}

export function taskStartLifecycleGuidance(
  lifecycleMode: string,
  mutationPolicy: string,
  taskId: string
): string {
  if (lifecycleMode === "automatic-readonly") {
    return "Runtime records targeted reads and final completion automatically. Stay read-only and report cited evidence.";
  }
  if (lifecycleMode === "assisted-readonly") {
    return "Runtime records read-only evidence automatically; complete only the explicit evidence-review step before handoff.";
  }
  if (mutationPolicy === "forbidden") {
    return "Runtime permits bounded inspection and exact configured verifier commands only. Source mutation is blocked, and completion requires a zero task delta.";
  }
  if (mutationPolicy === "allowed") {
    return "Verify and review first. Repair only findings supported by evidence; zero delta is valid, while any mutation remains guarded and every exact verifier must pass.";
  }
  if (lifecycleMode === "automatic") {
    return "Runtime will record reads, changes, exact verifier results, and final completion automatically. Continue with ordinary read/edit/bash work.";
  }
  if (lifecycleMode === "assisted") {
    return `Runtime records objective evidence automatically; after verification, complete only step \`review\` with piagent_task_progress using taskId \`${taskId}\` and stepId \`review\`.`;
  }
  return "Use the active progress/recovery tools for the custom or high-risk checkpoints.";
}

export function automaticTaskExpectedOutput(mutationPolicy: string): string {
  if (mutationPolicy === "forbidden") {
    return "The requested read-only investigation is answered from observed project evidence without mutating files.";
  }
  if (mutationPolicy === "allowed") {
    return "The current implementation is verified and any evidence-backed failure is repaired; zero task delta remains valid when no repair is needed.";
  }
  return "The requested bounded change is implemented and passes the configured verification.";
}
