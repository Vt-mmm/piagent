export type SessionOperationDeadlineReason = "operation-inactivity-timeout" | "operation-deadline-exceeded";

export type SessionOperationDeadlinePolicy = Readonly<{
  inactivityTimeoutMs: number;
  maximumDurationMs: number;
  terminationTimeoutMs: number;
  projectionTimeoutMs: number;
}>;

export type SessionOperationWatchdogOptions = Partial<SessionOperationDeadlinePolicy>;
export type BoundedResult<T> = { state: "settled"; value: T } | { state: "rejected"; error: unknown } | { state: "timeout" };
export type SessionOperationTerminationResult = { state: "settled" } | { state: "quarantine"; reasonCode: string };

export function bestEffortUnsubscribe(unsubscribe: (() => void) | null): void {
  try { unsubscribe?.(); } catch { /* broken host cleanup cannot retain operation authority */ }
}

// A silent tool/provider gets 15 minutes. Any observed host event refreshes that
// allowance, while the six-hour ceiling prevents an endless stream of progress
// events from retaining runtime authority forever. Cleanup itself is separately
// bounded so Stop and watchdog recovery cannot inherit the original hang.
const DEFAULT_POLICY: SessionOperationDeadlinePolicy = Object.freeze({
  inactivityTimeoutMs: 15 * 60_000,
  maximumDurationMs: 6 * 60 * 60_000,
  terminationTimeoutMs: 5_000,
  projectionTimeoutMs: 2_500
});
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const TERMINATION_CLEANUP_FAILED = "operation-termination-cleanup-failed";

function duration(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_TIMEOUT_MS) {
    throw new Error("session-operation-watchdog-config-invalid");
  }
  return Number(value);
}

export function sessionOperationDeadlinePolicy(options: SessionOperationWatchdogOptions = {}): SessionOperationDeadlinePolicy {
  const policy = {
    inactivityTimeoutMs: duration(options.inactivityTimeoutMs, DEFAULT_POLICY.inactivityTimeoutMs),
    maximumDurationMs: duration(options.maximumDurationMs, DEFAULT_POLICY.maximumDurationMs),
    terminationTimeoutMs: duration(options.terminationTimeoutMs, DEFAULT_POLICY.terminationTimeoutMs),
    projectionTimeoutMs: duration(options.projectionTimeoutMs, DEFAULT_POLICY.projectionTimeoutMs)
  };
  if (policy.projectionTimeoutMs > policy.terminationTimeoutMs) throw new Error("session-operation-watchdog-config-invalid");
  return Object.freeze(policy);
}

export async function boundedResult<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ state: "settled" as const, value }),
        (error: unknown) => ({ state: "rejected" as const, error })),
      new Promise<{ state: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ state: "timeout" }), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SessionOperationWatchdog {
  readonly policy: SessionOperationDeadlinePolicy;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #maximumTimer: ReturnType<typeof setTimeout> | null = null;
  #expire: ((reason: SessionOperationDeadlineReason) => void) | null = null;
  #closed = false;
  #termination: Promise<unknown> | null = null;

  constructor(policy: SessionOperationDeadlinePolicy) { this.policy = policy; }
  get terminating(): boolean { return this.#termination !== null; }

  start(expire: (reason: SessionOperationDeadlineReason) => void): void {
    if (this.#expire || this.#closed) throw new Error("session-operation-watchdog-state-invalid");
    this.#expire = expire;
    this.#armIdle();
    this.#maximumTimer = setTimeout(() => this.#deadline("operation-deadline-exceeded"), this.policy.maximumDurationMs);
    // An accepted operation owns live runtime work until it settles. Keep both
    // deadline timers referenced so a headless Gateway cannot let Node exit
    // while the provider promise is pending and silently skip recovery.
  }

  progress(): void {
    if (this.#closed || !this.#expire) return;
    this.#armIdle();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#maximumTimer) clearTimeout(this.#maximumTimer);
    this.#idleTimer = null; this.#maximumTimer = null; this.#expire = null;
  }

  terminate<T>(run: () => Promise<T>): Promise<T> {
    if (!this.#termination) { this.close(); this.#termination = Promise.resolve().then(run); }
    return this.#termination as Promise<T>;
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#deadline("operation-inactivity-timeout"), this.policy.inactivityTimeoutMs);
  }

  #deadline(reason: SessionOperationDeadlineReason): void {
    if (this.#closed) return;
    const expire = this.#expire; this.close(); expire?.(reason);
  }
}

export function armSessionOperationWatchdog(options: {
  watchdog: SessionOperationWatchdog;
  subscribe(listener: (event: unknown) => void): unknown;
  observe(event: unknown): void;
  expire(reason: SessionOperationDeadlineReason): void;
}): () => void {
  const unsubscribe = options.subscribe((event) => { options.watchdog.progress(); options.observe(event); });
  if (typeof unsubscribe !== "function") throw new Error("session-operation-subscribe-invalid");
  try { options.watchdog.start(options.expire); }
  catch (error) { try { unsubscribe(); } catch { /* authority is quarantined by the caller */ } throw error; }
  return () => { unsubscribe(); };
}

export async function terminateWatchedSessionOperation(options: {
  watchdog: SessionOperationWatchdog;
  settlement: "aborted" | "error";
  reasonCode: string;
  forcedReasonCode: string;
  stream: { markAborted(reasonCode: string): void; markError(reasonCode: string): void;
    forceLifecycleTermination(reasonCode: string): void };
  completion(): Promise<void> | null;
  settledCleanly(): boolean;
  cancelApproval(reasonCode: string): void;
  abortHost(): unknown;
  clearQueue?(): void;
}): Promise<SessionOperationTerminationResult> {
  return await options.watchdog.terminate(async () => {
    const mark = (reasonCode: string) => options.settlement === "aborted"
      ? options.stream.markAborted(reasonCode) : options.stream.markError(reasonCode);
    let cleanupFailed = false;
    try { options.cancelApproval(options.reasonCode); } catch { cleanupFailed = true; }
    try { options.clearQueue?.(); } catch { cleanupFailed = true; }
    const terminalReason = cleanupFailed ? TERMINATION_CLEANUP_FAILED : options.reasonCode;
    mark(terminalReason);
    void Promise.resolve().then(options.abortHost).catch(() => undefined);
    const completion = options.completion();
    const completed = completion ? await boundedResult(completion, options.watchdog.policy.terminationTimeoutMs)
      : { state: "timeout" as const };
    if (!cleanupFailed && completed.state === "settled" && options.settledCleanly()) return { state: "settled" as const };
    const quarantineReason = cleanupFailed ? TERMINATION_CLEANUP_FAILED : options.forcedReasonCode;
    mark(quarantineReason); options.stream.forceLifecycleTermination(quarantineReason);
    const forcedCompletion = options.completion();
    if (forcedCompletion) await boundedResult(forcedCompletion, options.watchdog.policy.projectionTimeoutMs);
    return { state: "quarantine" as const, reasonCode: quarantineReason };
  });
}
