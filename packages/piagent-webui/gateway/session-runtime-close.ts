import { boundedResult } from "./session-operation-watchdog.ts";

type ClosingRuntime = {
  operationRef: string | null;
  settling: boolean;
  completion: Promise<void> | null;
  stream: { markError(reasonCode: string): void } | null;
};

/** Drain ordinary settlement, then revoke authority for work that cannot finish. */
export async function closeSessionRuntimes<T extends ClosingRuntime>(options: {
  opening: ReadonlyMap<string, Promise<unknown>>;
  active: ReadonlyMap<string, T>;
  terminationTimeoutMs: number;
  abort(sessionRef: string, operationRef: string): Promise<void>;
  release(sessionRef: string): Promise<unknown>;
  quarantine(sessionRef: string, operationRef: string, active: T, reasonCode: string): Promise<void>;
}): Promise<void> {
  await Promise.allSettled([...options.opening.values()]);
  await Promise.allSettled([...options.active.entries()].filter(([, active]) => active.operationRef)
    .map(([sessionRef, active]) => options.abort(sessionRef, active.operationRef!)));
  await Promise.allSettled([...options.active.entries()].map(async ([sessionRef, active]) => {
    // Normal settlement owns its completion promise and cannot be aborted.
    if (active.settling && active.completion) {
      await boundedResult(active.completion, options.terminationTimeoutMs);
    }
    if (options.active.get(sessionRef) !== active) return;
    if (active.operationRef && active.stream) {
      const reasonCode = "session-runtime-shutdown-incomplete";
      active.stream.markError(reasonCode);
      await options.quarantine(sessionRef, active.operationRef, active, reasonCode);
      return;
    }
    await options.release(sessionRef);
  }));
}
