import { useCallback, useEffect, useRef, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { readSnapshot, WebUiRequestError } from "./api.ts";
import { bootstrapBrowserSession } from "./bootstrap.ts";
import type { RuntimeStreamEvent } from "./chat-view-model.ts";
import { SingleFlightRequest, type SingleFlightFailureDisposition, type SingleFlightOutcome } from "./latest-request.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "failed";

const RESYNC_RETRY_BASE_MS = 250;
const RESYNC_RETRY_MAX_MS = 4_000;
const EVENT_CURSOR = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

export function inspectionSnapshotRetryDelay(failureCount: number): number {
  return Math.min(RESYNC_RETRY_BASE_MS * (2 ** Math.min(Math.max(0, failureCount), 16)), RESYNC_RETRY_MAX_MS);
}

export function inspectionSnapshotFailureDisposition(error: unknown): SingleFlightFailureDisposition {
  if (error instanceof WebUiRequestError) {
    return error.status === 408 || error.status === 409 || error.status === 423 || error.status === 425 || error.status === 429 || error.status >= 500
      ? "retryable" : "terminal";
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return "terminal";
  return error instanceof TypeError ? "retryable" : "terminal";
}

export function acceptedInspectionEventCursor(current: string | null, ...candidates: unknown[]): string | null {
  for (const candidate of candidates) if (typeof candidate === "string" && EVENT_CURSOR.test(candidate)) return candidate;
  return current;
}

export function validatedInspectionSnapshot(value: unknown): PiagentWebUICanonicalSnapshotV1 {
  if (!value || typeof value !== "object") throw new Error("invalid-inspection-snapshot");
  const candidate = value as Record<string, unknown>;
  const requiredObjects = ["identity", "revision", "capabilities", "session", "sourceChanges", "activity", "approvals",
    "verification", "usage", "continuation", "health"];
  if (candidate.schemaVersion !== 1 || candidate.version !== "piagent-webui-snapshot-v1"
    || typeof candidate.generatedAt !== "string"
    || requiredObjects.some((key) => !candidate[key] || typeof candidate[key] !== "object")) {
    throw new Error("invalid-inspection-snapshot");
  }
  const revision = candidate.revision as Record<string, unknown>;
  if (typeof revision.eventCursor !== "string" || !EVENT_CURSOR.test(revision.eventCursor)) {
    throw new Error("invalid-inspection-snapshot-cursor");
  }
  return value as PiagentWebUICanonicalSnapshotV1;
}

function cancelledOutcome<T>(readSequence = 0): SingleFlightOutcome<T> {
  return { state: "cancelled", readSequence };
}

export async function recoverInitialInspectionSnapshot<T>(input: {
  read(): Promise<SingleFlightOutcome<T>>;
  wait(delayMs: number): Promise<void>;
  stopped(): boolean;
}): Promise<SingleFlightOutcome<T>> {
  let failureCount = 0;
  while (!input.stopped()) {
    const outcome = await input.read();
    if (input.stopped()) return cancelledOutcome(outcome.readSequence);
    if (outcome.state !== "retryable-error") return outcome;
    await input.wait(inspectionSnapshotRetryDelay(failureCount));
    failureCount = Math.min(failureCount + 1, 16);
  }
  return cancelledOutcome();
}

type InspectionSnapshotRead = { snapshot: PiagentWebUICanonicalSnapshotV1; eventGenerationAtStart: number };

export function useInspection(): { snapshot?: PiagentWebUICanonicalSnapshotV1; connection: ConnectionState; events: RuntimeStreamEvent[];
  refreshSnapshot(): Promise<PiagentWebUICanonicalSnapshotV1 | undefined> } {
  const [snapshot, setSnapshot] = useState<PiagentWebUICanonicalSnapshotV1>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [events, setEvents] = useState<RuntimeStreamEvent[]>([]);
  const snapshotRequestRef = useRef<() => Promise<SingleFlightOutcome<PiagentWebUICanonicalSnapshotV1>>>(
    () => Promise.resolve(cancelledOutcome()));
  const resumeTransportRef = useRef<(snapshot: PiagentWebUICanonicalSnapshotV1) => void>(() => undefined);
  const refreshSnapshot = useCallback(async () => {
    const outcome = await snapshotRequestRef.current();
    if (outcome.state !== "committed") return undefined;
    resumeTransportRef.current(outcome.value);
    return outcome.value;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | undefined;
    let refreshTimer: number | undefined;
    let liveRetryTimer: number | undefined;
    let recoveryTimer: number | undefined;
    let recoveryWake: (() => void) | undefined;
    let recoverySerial = 0;
    let transportFailureCount = 0;
    let liveFailureCount = 0;
    let eventGeneration = 0;
    let latestAcceptedEventCursor: string | null = null;
    let bootstrapReady = false;
    let hasCommittedSnapshot = false;
    let canonicalHealthy = false;
    let transportOpen = false;
    let liveRefreshRunning = false;
    let liveRefreshDirty = false;
    let terminal = false;
    let stopped = false;

    const clearRefreshTimer = () => { window.clearTimeout(refreshTimer); refreshTimer = undefined; };
    const clearLiveRetryTimer = () => { window.clearTimeout(liveRetryTimer); liveRetryTimer = undefined; };
    const clearRecoveryWait = () => {
      window.clearTimeout(recoveryTimer); recoveryTimer = undefined;
      const wake = recoveryWake; recoveryWake = undefined; wake?.();
    };
    const waitForRecovery = (delayMs: number) => new Promise<void>((resolve) => {
      const wake = () => {
        if (recoveryWake === wake) { recoveryWake = undefined; recoveryTimer = undefined; }
        resolve();
      };
      recoveryWake = wake;
      recoveryTimer = window.setTimeout(wake, delayMs);
    });
    const cancelRecovery = () => { recoverySerial += 1; clearRecoveryWait(); };

    let coordinator: SingleFlightRequest<InspectionSnapshotRead>;
    const failInspection = () => {
      if (stopped || terminal) return;
      terminal = true; cancelRecovery(); clearRefreshTimer(); clearLiveRetryTimer();
      controller.abort(); coordinator.invalidate();
      stream?.close(); stream = undefined; transportOpen = false;
      setConnection("failed");
    };
    coordinator = new SingleFlightRequest<InspectionSnapshotRead>({
      read: async () => {
        const eventGenerationAtStart = eventGeneration;
        return { snapshot: validatedInspectionSnapshot(await readSnapshot(controller.signal)), eventGenerationAtStart };
      },
      commit: ({ snapshot: next, eventGenerationAtStart }) => {
        if (stopped || terminal) return;
        hasCommittedSnapshot = true; canonicalHealthy = true;
        if (eventGeneration === eventGenerationAtStart) {
          latestAcceptedEventCursor = acceptedInspectionEventCursor(null, next.revision.eventCursor);
        }
        setSnapshot(next);
        if (transportOpen) setConnection("connected");
      },
      classify: inspectionSnapshotFailureDisposition
    });

    const requestSnapshot = async (): Promise<SingleFlightOutcome<PiagentWebUICanonicalSnapshotV1>> => {
      const outcome = await coordinator.request();
      if (outcome.state === "committed") return { ...outcome, value: outcome.value.snapshot };
      if (outcome.state === "terminal-error") failInspection();
      return outcome;
    };
    snapshotRequestRef.current = requestSnapshot;

    let beginRecovery: (initialDelayMs?: number, clearEvents?: boolean) => void = () => undefined;
    let scheduleRefresh: () => void = () => undefined;
    const connect = () => {
      if (stopped || terminal || !bootstrapReady || !hasCommittedSnapshot || stream) return;
      cancelRecovery();
      const query = latestAcceptedEventCursor ? `?after=${encodeURIComponent(latestAcceptedEventCursor)}` : "";
      let candidate: EventSource;
      try { candidate = new EventSource(`/api/v1/events${query}`, { withCredentials: true }); }
      catch {
        transportFailureCount = Math.min(transportFailureCount + 1, 16);
        setConnection("reconnecting"); beginRecovery(inspectionSnapshotRetryDelay(transportFailureCount - 1)); return;
      }
      stream = candidate; transportOpen = false;
      setConnection((current) => current === "connecting" ? "connecting" : "reconnecting");
      candidate.onopen = () => {
        if (stopped || terminal || stream !== candidate) return;
        transportOpen = true; transportFailureCount = 0;
        setConnection(canonicalHealthy ? "connected" : "reconnecting");
      };
      candidate.addEventListener("runtime-event", (raw) => {
        if (stopped || terminal || stream !== candidate) return;
        try {
          const message = raw as MessageEvent;
          const value = JSON.parse(message.data) as RuntimeStreamEvent;
          if (!value || typeof value.kind !== "string") return;
          const acceptedCursor = acceptedInspectionEventCursor(latestAcceptedEventCursor, message.lastEventId, value.eventCursor);
          if (acceptedCursor !== latestAcceptedEventCursor) { latestAcceptedEventCursor = acceptedCursor; eventGeneration += 1; }
          setEvents((current) => [...current, value].slice(-500));
          if (!["message.text-delta", "message.thinking-state", "activity.progress"].includes(String(value.kind))) scheduleRefresh();
        } catch { /* Malformed events cannot advance the client-owned cursor. */ }
      });
      candidate.addEventListener("resync-required", () => {
        if (stopped || terminal || stream !== candidate) return;
        candidate.close(); stream = undefined; transportOpen = false;
        clearRefreshTimer(); clearLiveRetryTimer(); liveRefreshDirty = false;
        setEvents([]); setConnection("reconnecting"); beginRecovery(0, true);
      });
      candidate.onerror = () => {
        if (stopped || terminal || stream !== candidate) return;
        // close() cancels native reconnect, avoiding fixed ?after versus Last-Event-ID conflicts.
        candidate.close(); stream = undefined; transportOpen = false; canonicalHealthy = false;
        transportFailureCount = Math.min(transportFailureCount + 1, 16);
        setConnection("reconnecting"); beginRecovery(inspectionSnapshotRetryDelay(transportFailureCount - 1));
      };
    };

    beginRecovery = (initialDelayMs = 0, clearEvents = false) => {
      if (stopped || terminal) return;
      const requestSerial = ++recoverySerial; clearRecoveryWait();
      if (clearEvents) setEvents([]);
      setConnection(hasCommittedSnapshot ? "reconnecting" : "connecting");
      void (async () => {
        if (initialDelayMs > 0) await waitForRecovery(initialDelayMs);
        if (stopped || terminal || recoverySerial !== requestSerial || stream) return;
        const outcome = await recoverInitialInspectionSnapshot({ read: requestSnapshot, wait: waitForRecovery,
          stopped: () => stopped || terminal || recoverySerial !== requestSerial || Boolean(stream) });
        if (stopped || terminal || recoverySerial !== requestSerial || stream) return;
        if (outcome.state === "committed") connect();
      })();
    };

    const scheduleLiveRetry = () => {
      if (stopped || terminal || !stream || liveRetryTimer !== undefined) return;
      const delay = inspectionSnapshotRetryDelay(liveFailureCount);
      liveFailureCount = Math.min(liveFailureCount + 1, 16);
      liveRetryTimer = window.setTimeout(() => {
        liveRetryTimer = undefined; liveRefreshDirty = true; void runLiveRefresh();
      }, delay);
    };
    const runLiveRefresh = async () => {
      if (stopped || terminal || !stream) return;
      if (liveRefreshRunning) { liveRefreshDirty = true; return; }
      liveRefreshRunning = true;
      try {
        do {
          liveRefreshDirty = false;
          const outcome = await requestSnapshot();
          if (stopped || terminal || !stream || outcome.state === "cancelled" || outcome.state === "terminal-error") return;
          if (outcome.state === "retryable-error") {
            canonicalHealthy = false; setConnection("reconnecting"); liveRefreshDirty = true; scheduleLiveRetry(); return;
          }
          liveFailureCount = 0;
        } while (liveRefreshDirty && !stopped && !terminal && Boolean(stream));
      } finally {
        liveRefreshRunning = false;
        if (liveRefreshDirty && liveRetryTimer === undefined && refreshTimer === undefined && stream && !terminal && !stopped) {
          refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void runLiveRefresh(); }, 80);
        }
      }
    };
    scheduleRefresh = () => {
      liveRefreshDirty = true;
      if (stopped || terminal || liveRefreshRunning || liveRetryTimer !== undefined || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void runLiveRefresh(); }, 80);
    };

    const resumeTransport = (_next: PiagentWebUICanonicalSnapshotV1) => {
      if (!stopped && !terminal && bootstrapReady && !stream) connect();
    };
    resumeTransportRef.current = resumeTransport;

    void (async () => {
      let bootstrap;
      try { bootstrap = await bootstrapBrowserSession(); }
      catch { if (!stopped && !terminal) failInspection(); return; }
      if (stopped || terminal) return;
      if (bootstrap === "failed") { failInspection(); return; }
      bootstrapReady = true; beginRecovery();
    })();

    return () => {
      stopped = true; cancelRecovery(); controller.abort(); coordinator.invalidate();
      stream?.close(); clearRefreshTimer(); clearLiveRetryTimer();
      if (resumeTransportRef.current === resumeTransport) resumeTransportRef.current = () => undefined;
      if (snapshotRequestRef.current === requestSnapshot) snapshotRequestRef.current = () => Promise.resolve(cancelledOutcome());
    };
  }, []);

  return { snapshot, connection, events, refreshSnapshot };
}
