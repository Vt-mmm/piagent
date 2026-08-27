export class LatestRequestWins<T> {
  #serial = 0;

  run(read: () => Promise<T>, accept: (value: T) => void, reject: () => void): Promise<T | undefined> {
    const requestSerial = ++this.#serial;
    return (async () => {
      try {
        const value = await read();
        if (requestSerial === this.#serial) accept(value);
        return value;
      } catch {
        if (requestSerial === this.#serial) reject();
        return undefined;
      }
    })();
  }

  invalidate(): void { this.#serial += 1; }
}

export type SingleFlightFailureDisposition = "retryable" | "terminal";
export type SingleFlightOutcome<T> =
  | { state: "committed"; value: T; readSequence: number }
  | { state: "retryable-error" | "terminal-error"; error: unknown; readSequence: number }
  | { state: "cancelled"; readSequence: number };

type SingleFlightWaiter<T> = { ticket: number; resolve(value: SingleFlightOutcome<T>): void };

/**
 * Serializes one canonical read while retaining one dirty follow-up batch.
 * A request made during an active read is satisfied only by the next read, so
 * callers never mistake a pre-request snapshot for their own refresh.
 */
export class SingleFlightRequest<T> {
  readonly #read: () => Promise<T>;
  readonly #commit: (value: T) => void;
  readonly #classify: (error: unknown) => SingleFlightFailureDisposition;
  #requestedTicket = 0;
  #readSequence = 0;
  #running = false;
  #invalidated = false;
  #waiters: SingleFlightWaiter<T>[] = [];

  constructor(input: { read(): Promise<T>; commit(value: T): void;
    classify(error: unknown): SingleFlightFailureDisposition }) {
    this.#read = input.read;
    this.#commit = input.commit;
    this.#classify = input.classify;
  }

  request(): Promise<SingleFlightOutcome<T>> {
    if (this.#invalidated) return Promise.resolve({ state: "cancelled", readSequence: this.#readSequence });
    const ticket = ++this.#requestedTicket;
    const pending = new Promise<SingleFlightOutcome<T>>((resolve) => this.#waiters.push({ ticket, resolve }));
    void this.#drain();
    return pending;
  }

  invalidate(): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    const cancelled: SingleFlightOutcome<T> = { state: "cancelled", readSequence: this.#readSequence };
    const waiters = this.#waiters; this.#waiters = [];
    for (const waiter of waiters) waiter.resolve(cancelled);
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#invalidated) return;
    this.#running = true;
    try {
      while (!this.#invalidated && this.#waiters.length > 0) {
        const targetTicket = this.#requestedTicket;
        const readSequence = ++this.#readSequence;
        let outcome: SingleFlightOutcome<T>;
        try {
          const value = await this.#read();
          if (this.#invalidated) return;
          try {
            this.#commit(value);
            outcome = { state: "committed", value, readSequence };
          } catch (error) {
            // A value that cannot be committed is a contract/programming error,
            // not a transport failure. Retrying the same malformed value loops.
            outcome = { state: "terminal-error", error, readSequence };
          }
        } catch (error) {
          if (this.#invalidated) return;
          outcome = { state: this.#classify(error) === "retryable" ? "retryable-error" : "terminal-error",
            error, readSequence };
        }
        const satisfied = this.#waiters.filter((waiter) => waiter.ticket <= targetTicket);
        this.#waiters = this.#waiters.filter((waiter) => waiter.ticket > targetTicket);
        for (const waiter of satisfied) waiter.resolve(outcome);
        if (outcome.state === "terminal-error") {
          this.#invalidated = true;
          const cancelled: SingleFlightOutcome<T> = { state: "cancelled", readSequence };
          const remaining = this.#waiters; this.#waiters = [];
          for (const waiter of remaining) waiter.resolve(cancelled);
        }
      }
    } finally {
      this.#running = false;
      if (!this.#invalidated && this.#waiters.length > 0) void this.#drain();
    }
  }
}
