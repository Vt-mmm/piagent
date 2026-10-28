import { parentPort, workerData } from 'node:worker_threads';
import { matchesProtectedPath } from './policy-core.js';
import { workingTreeSnapshot } from './task-state.js';
// Hash the working tree away from the thread that draws the terminal.
const { cwd, gitTimeoutMs, protectedPaths } = workerData;
parentPort.postMessage(workingTreeSnapshot(cwd, {
  gitTimeoutMs,
  isProtectedProjectPath: (projectPath) => Boolean(matchesProtectedPath(projectPath, protectedPaths))
}));
