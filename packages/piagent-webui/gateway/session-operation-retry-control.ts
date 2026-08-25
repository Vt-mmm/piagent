type RetryObservation = { retry?: unknown } | null | undefined;

function invoke(action: (() => unknown) | null): void {
  if (!action) return;
  try {
    const result = action();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch { /* the operation watchdog remains the terminal authority */ }
}

/**
 * Cancels a host-owned provider retry without replaying the prompt. Pinned Pi
 * creates its retry AbortController immediately after auto_retry_start is
 * emitted, so the microtask always runs before even a zero-millisecond timer.
 */
export class SessionOperationRetryCancellation {
  readonly #session: any;
  #fallbackIssued = false;

  constructor(session: any) { this.#session = session; }

  observe(observation: RetryObservation): void {
    if (observation?.retry !== "abort") return;
    if (typeof this.#session?.abortRetry === "function") {
      const cancel = () => invoke(() => this.#session.abortRetry());
      cancel();
      queueMicrotask(cancel);
      return;
    }
    // Unknown hosts fail closed once. Replaying a tool-capable turn is more
    // dangerous than ending the logical operation with an explicit error.
    if (this.#fallbackIssued || typeof this.#session?.abort !== "function") return;
    this.#fallbackIssued = true;
    invoke(() => this.#session.abort());
  }
}
