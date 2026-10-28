import { Worker } from "node:worker_threads";

import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";

type Snapshot = Record<string, string>;
type Options = { gitTimeoutMs: number; protectedPaths: string[] };

// The inspection hashes every changed and loose file. On the main thread that
// froze the terminal for seconds after each answer in a folder of
// repositories, twice (turn end, then agent settled). A worker keeps the
// terminal drawing; refreshes that overlap share one scan.
const inFlight = new Map<string, Promise<Snapshot>>();

function inline(cwd: string, options: Options): Snapshot {
  return workingTreeSnapshot(cwd, {
    gitTimeoutMs: options.gitTimeoutMs,
    isProtectedProjectPath: (projectPath: string) => Boolean(matchesProtectedPath(projectPath, options.protectedPaths))
  }) as Snapshot;
}

function scan(cwd: string, options: Options): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../../extensions/working-tree-snapshot-worker.mjs", import.meta.url),
        { workerData: { cwd, ...options } });
    } catch {
      resolve(inline(cwd, options));
      return;
    }
    let settled = false;
    const fallback = () => {
      if (settled) return; settled = true;
      try { resolve(inline(cwd, options)); } catch (error) { reject(error); }
    };
    worker.once("message", (snapshot: Snapshot) => {
      if (settled) return; settled = true; resolve(snapshot); void worker.terminate();
    });
    worker.once("error", fallback);
    worker.once("exit", fallback);
  });
}

export function workingTreeSnapshotOffThread(cwd: string, options: Options): Promise<Snapshot> {
  const key = JSON.stringify([cwd, options.gitTimeoutMs, options.protectedPaths]);
  const running = inFlight.get(key);
  if (running) return running;
  const started = scan(cwd, options).finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
