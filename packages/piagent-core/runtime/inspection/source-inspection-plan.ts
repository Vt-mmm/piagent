import type { GitStatusRecord, GitStatusSnapshot } from "./git-status-adapter.ts";

type ProtectedPathCheck = (repoRoot: string, repoPath: string) => boolean;

export type SourceInspectionPlan = {
  objectIds: string[];
  workingTreePaths: string[];
  stagedPaths: string[];
};

function visible(record: GitStatusRecord): boolean {
  const paths = [record.path.value, record.oldPath?.value].filter((value): value is string => Boolean(value));
  return paths.length > 0 && !paths.some((repoPath) => repoPath === ".pi/piagent-state" || repoPath.startsWith(".pi/piagent-state/"));
}

export function sourceInspectionPlan(
  snapshot: GitStatusSnapshot,
  isProtectedPath?: ProtectedPathCheck
): SourceInspectionPlan {
  const safeRecords = snapshot.records.filter((record) => {
    const repoPath = record.path.value;
    const oldPath = record.oldPath?.value;
    return visible(record)
      && isProtectedPath?.(snapshot.repoRoot, repoPath as string) !== true
      && (!oldPath || isProtectedPath?.(snapshot.repoRoot, oldPath) !== true);
  });
  const objectIds = [...new Set(safeRecords.flatMap((record) =>
    [record.headObject, record.indexObject].filter((value): value is string => Boolean(value) && !/^0+$/.test(value))
  ))];
  const paths = [...new Set(safeRecords.flatMap((record) =>
    [record.path.value, record.oldPath?.value].filter((value): value is string => Boolean(value))
  ))];
  return { objectIds, workingTreePaths: paths, stagedPaths: paths };
}
