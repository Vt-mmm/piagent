export const STABLE_IDENTITY_FIELDS = ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId"] as const;

export function stableIdentityMatches(left: Record<string, any> | null | undefined, right: Record<string, any> | null | undefined): boolean {
  return Boolean(left && right && STABLE_IDENTITY_FIELDS.every((field) => left[field] === right[field]));
}

export function sourceBinding(snapshot: Record<string, any>) {
  return { sourceProjectionRevision: snapshot.sourceChanges.projectionRevision,
    taskViewRevision: snapshot.sourceChanges.task.revision, workspaceRevision: snapshot.sourceChanges.workingTree.revision,
    indexRevision: snapshot.sourceChanges.staged.revision };
}

export function sourceDocumentMatches(document: Record<string, any> | null | undefined, snapshot: Record<string, any>): boolean {
  const binding = sourceBinding(snapshot);
  return Boolean(document && stableIdentityMatches(document.identity, snapshot.identity)
    && Object.entries(binding).every(([field, value]) => document.snapshotBinding?.[field] === value));
}

