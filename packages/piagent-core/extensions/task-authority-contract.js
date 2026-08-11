import { taskAuthoritySnapshotValidationErrors } from "../capabilities/authority-manifest.ts";

export function taskAuthorityContractValidationErrors(task) {
  if (task?.authoritySnapshot === undefined) return [];
  const errors = taskAuthoritySnapshotValidationErrors(task.authoritySnapshot);
  if (errors.length === 0 && (
    task.authoritySnapshot.taskId !== task.taskId
    || task.authoritySnapshot.taskRunId !== task.taskRunId
    || task.authoritySnapshot.capturedAt !== task.createdAt
  )) errors.push("task authority snapshot identity/time must match its Task Contract");
  return errors.map((error) => `authoritySnapshot ${error}`);
}

export function normalizeTaskAuthoritySnapshot(value) {
  return value === undefined ? undefined : structuredClone(value);
}
