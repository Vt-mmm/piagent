import { hasVisibleText } from "../shared/text-visibility.ts";

export type SessionOperationPhase = "pending" | "running" | "retry" | "compaction" | "settled";

export type SessionOperationRetryPolicy = Readonly<{
  maximumAttempts: number;
  maximumDelayMs: number;
}>;

export type SessionOperationRetryPolicyOptions = Partial<SessionOperationRetryPolicy>;

export type SessionOperationObservation = Readonly<{
  accepted: boolean;
  phase: SessionOperationPhase;
  retry: "none" | "allowed" | "abort";
  reasonCode: string | null;
}>;

const DEFAULT_RETRY_POLICY: SessionOperationRetryPolicy = Object.freeze({
  // Pi's provider retry is useful before a response exists, but a long retry
  // chain burns quota and keeps the browser in Working. One automatic retry
  // absorbs an ordinary transient failure without replaying a persistent one.
  maximumAttempts: 1,
  maximumDelayMs: 8_000
});

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error("session-operation-retry-policy-invalid");
  }
  return Number(value);
}

export function sessionOperationRetryPolicy(
  options: SessionOperationRetryPolicyOptions = {}
): SessionOperationRetryPolicy {
  return Object.freeze({
    maximumAttempts: boundedInteger(options.maximumAttempts, DEFAULT_RETRY_POLICY.maximumAttempts, 0, 10),
    maximumDelayMs: boundedInteger(options.maximumDelayMs, DEFAULT_RETRY_POLICY.maximumDelayMs, 0, 300_000)
  });
}

function correlationRef(event: any): string | null {
  for (const key of ["operationRef", "agentOperationId", "operationId"]) {
    if (typeof event?.[key] === "string" && event[key]) return event[key];
  }
  return null;
}

function visibleAssistantContent(message: any): boolean {
  if (typeof message?.content === "string") return hasVisibleText(message.content);
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((item: any) => {
    if (item?.type === "text") return hasVisibleText(item.text);
    // Images and every model-emitted tool/server-tool block are observable
    // output even when they do not contain user-visible text.
    return ["image", "image_url", "toolCall", "tool_call", "tool_use", "server_tool_use"]
      .includes(String(item?.type ?? ""));
  });
}

function attempt(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function delay(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/**
 * Operation-local authority for provider retry, compaction and settlement.
 *
 * Pi's pinned host owns the actual provider retry. This state machine owns the
 * stricter Piagent admission decision and is shared by the Gateway stream and
 * runtime supervisor. It never treats compaction as a provider retry, and it
 * fails closed once assistant output or a tool call makes replay unsafe.
 */
export class SessionOperationLifecycle {
  readonly operationRef: string;
  readonly retryPolicy: SessionOperationRetryPolicy;
  #phase: SessionOperationPhase = "pending";
  #started = false;
  #hostSettled = false;
  #terminal = false;
  #visibleAssistantOutput = false;
  #toolCallObserved = false;
  #lastRetryAttempt = 0;
  #activeRetryAttempt: number | null = null;
  #retryAbortRequired = false;

  constructor(options: {
    operationRef: string;
    retryPolicy?: SessionOperationRetryPolicyOptions | SessionOperationRetryPolicy;
  }) {
    this.operationRef = options.operationRef;
    this.retryPolicy = sessionOperationRetryPolicy(options.retryPolicy);
  }

  get phase(): SessionOperationPhase { return this.#phase; }
  get started(): boolean { return this.#started; }
  get hostSettled(): boolean { return this.#hostSettled; }
  get terminal(): boolean { return this.#terminal; }
  get replayUnsafe(): boolean { return this.#visibleAssistantOutput || this.#toolCallObserved; }
  get retryAbortRequired(): boolean { return this.#retryAbortRequired; }

  forceHostSettlement(): void {
    this.#started = true;
    this.#hostSettled = true;
    this.#phase = "settled";
  }

  markTerminal(): boolean {
    if (this.#terminal) return false;
    this.#terminal = true;
    this.#hostSettled = true;
    this.#phase = "settled";
    return true;
  }

  observe(event: any): SessionOperationObservation {
    if (this.#terminal || this.#hostSettled) return this.#ignored("operation-event-after-settlement");
    const correlated = correlationRef(event);
    if (correlated && correlated !== this.operationRef) return this.#ignored("operation-correlation-mismatch");
    const type = String(event?.type ?? "");

    if (type === "agent_start") {
      this.#started = true;
      this.#phase = "running";
      return this.#accepted();
    }
    if (type === "agent_settled") {
      this.#started = true;
      this.#hostSettled = true;
      this.#phase = "settled";
      return this.#accepted();
    }

    // Direct stream fixtures and some deferred command hosts begin with a
    // message/tool event. Treat that as an observed start while still refusing
    // uncorrelated retry/compaction lifecycle events before any operation work.
    if (["message_start", "message_update", "message_end", "tool_execution_start",
      "tool_execution_update", "tool_execution_end", "turn_start", "turn_end"].includes(type)) {
      this.#started = true;
      if (this.#phase === "pending") this.#phase = "running";
    }

    if (type === "message_update") {
      const update = event?.assistantMessageEvent;
      if (update?.type === "text_delta" && hasVisibleText(update.delta)) this.#visibleAssistantOutput = true;
      if (visibleAssistantContent(event?.message)) this.#visibleAssistantOutput = true;
      return this.#accepted();
    }
    if (type === "message_end" && event?.message?.role === "assistant") {
      if (visibleAssistantContent(event.message)) this.#visibleAssistantOutput = true;
      return this.#accepted();
    }
    if (type === "tool_execution_start") {
      this.#toolCallObserved = true;
      return this.#accepted();
    }

    if (type === "agent_end" && event?.willRetry === true && this.replayUnsafe) {
      return this.#abortRetry("automatic-retry-replay-unsafe");
    }
    if (type === "auto_retry_start") return this.#retryStarted(event);
    if (type === "auto_retry_end") return this.#retryEnded(event);

    // Summarization retries belong to compaction and never consume or inherit
    // the provider-turn retry budget.
    if (type === "compaction_start") {
      if (!this.#started) return this.#ignored("operation-event-before-start");
      if (this.#phase === "retry") this.#retryAbortRequired = true;
      this.#phase = "compaction";
      return this.#retryAbortRequired
        ? this.#abortRetry("automatic-retry-compaction-overlap")
        : this.#accepted();
    }
    if (type === "compaction_end") {
      if (this.#phase !== "compaction") return this.#ignored("compaction-event-stale");
      this.#phase = "running";
      return this.#accepted();
    }
    if (["summarization_retry_scheduled", "summarization_retry_attempt_start",
      "summarization_retry_finished"].includes(type)) {
      return this.#phase === "compaction" ? this.#accepted() : this.#ignored("compaction-event-stale");
    }
    return this.#accepted();
  }

  #retryStarted(event: any): SessionOperationObservation {
    if (!this.#started) return this.#ignored("operation-event-before-start");
    const currentAttempt = attempt(event?.attempt), currentDelay = delay(event?.delayMs);
    if (currentAttempt === null || currentDelay === null) return this.#abortRetry("automatic-retry-metadata-invalid");
    if (currentAttempt === this.#lastRetryAttempt) return this.#ignored("automatic-retry-event-duplicate");
    if (currentAttempt !== this.#lastRetryAttempt + 1) {
      this.#activeRetryAttempt = currentAttempt;
      this.#phase = "retry";
      return this.#abortRetry("automatic-retry-attempt-stale");
    }
    this.#lastRetryAttempt = currentAttempt;
    this.#activeRetryAttempt = currentAttempt;
    if (this.#phase === "compaction") return this.#abortRetry("automatic-retry-compaction-overlap");
    this.#phase = "retry";
    if (this.replayUnsafe) return this.#abortRetry("automatic-retry-replay-unsafe");
    if (currentAttempt > this.retryPolicy.maximumAttempts) return this.#abortRetry("automatic-retry-attempt-limit");
    if (currentDelay > this.retryPolicy.maximumDelayMs) return this.#abortRetry("automatic-retry-delay-limit");
    return { accepted: true, phase: this.#phase, retry: "allowed", reasonCode: null };
  }

  #retryEnded(event: any): SessionOperationObservation {
    const currentAttempt = attempt(event?.attempt);
    if (currentAttempt === null || currentAttempt !== this.#activeRetryAttempt) {
      return this.#ignored("automatic-retry-event-stale");
    }
    this.#activeRetryAttempt = null;
    // Keep the highest attempt for the whole logical operation so hosts that
    // emit retry_end between attempts still have a monotonic sequence. Keep an
    // abort latched too: retry_end can arrive synchronously before the
    // supervisor's cancellation microtask observes the host AbortController.
    if (this.#phase === "retry") this.#phase = "running";
    return this.#accepted();
  }

  #abortRetry(reasonCode: string): SessionOperationObservation {
    this.#retryAbortRequired = true;
    return { accepted: true, phase: this.#phase, retry: "abort", reasonCode };
  }

  #accepted(): SessionOperationObservation {
    return { accepted: true, phase: this.#phase, retry: "none", reasonCode: null };
  }

  #ignored(reasonCode: string): SessionOperationObservation {
    return { accepted: false, phase: this.#phase, retry: "none", reasonCode };
  }
}
