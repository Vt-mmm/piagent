import { performance } from "node:perf_hooks";

export const MAX_SESSION_WAIT_SECONDS = 3600;
export const SESSION_WAIT_ENTRY = "piagent-session-wait-v1";

export type WaitReceipt = {
  outcome: "elapsed" | "interrupted";
  elapsedMs: number;
};

/** One timer, no polling, provider dispatch, shell, or detached continuation. */
export class SessionWaitRuntime {
  private readonly active = new Map<string, () => void>();

  interrupt(key: string): void { this.active.get(key)?.(); }

  wait(key: string, seconds: number, signal?: AbortSignal): Promise<WaitReceipt> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SESSION_WAIT_SECONDS) {
      throw new Error(`Wait seconds must be an integer between 1 and ${MAX_SESSION_WAIT_SECONDS}.`);
    }
    if (this.active.has(key)) throw new Error("A wait is already active for this session.");
    if (signal?.aborted) return Promise.resolve({ outcome: "interrupted", elapsedMs: 0 });
    return new Promise((resolve) => {
      const started = performance.now();
      let settled = false;
      const finish = (outcome: WaitReceipt["outcome"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", interrupt);
        this.active.delete(key);
        resolve({ outcome, elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
      };
      const interrupt = () => finish("interrupted");
      const timer = setTimeout(() => finish("elapsed"), seconds * 1000);
      this.active.set(key, interrupt);
      signal?.addEventListener("abort", interrupt, { once: true });
      // Covers an abort observed between entry and listener registration.
      if (signal?.aborted) interrupt();
    });
  }
}
