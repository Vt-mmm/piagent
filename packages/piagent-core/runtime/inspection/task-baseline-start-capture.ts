import { captureTaskBaselineManifest } from "./source-evidence-store.ts";

export async function captureTaskStartBaseline(input: {
  projectRoot: string;
  taskId: string;
  taskRunId: string;
  sessionId: string;
  capturedAt: string;
  baselineTreeDigest: string;
  protectedPaths: string[];
  matchesProtectedPath: (path: string, patterns: string[]) => unknown;
}): Promise<void> {
  await captureTaskBaselineManifest({
    projectRoot: input.projectRoot,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    capturedAt: input.capturedAt,
    baselineTreeDigest: input.baselineTreeDigest,
    isProtectedProjectPath: (projectPath) => Boolean(input.matchesProtectedPath(projectPath, input.protectedPaths))
  });
}
