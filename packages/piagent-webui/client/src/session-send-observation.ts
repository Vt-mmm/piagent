import { readSessionLiveState, readSessionTranscript } from "./api.ts";
import { markUserMessageDelivery, type LiveConversation } from "./live-state-view-model.ts";
import { persistedLiveConversationHasFinal, persistedUserTextMatches } from "./transcript-view-model.ts";
import { canonicalOperationAfter, newerOperationObservation, type OperationObservation } from "./session-send-state.ts";

export type SessionSendEffect = { operationRef: string | null; complete: boolean };
export const SESSION_SEND_OBSERVATION_TIMEOUT_MS = 5_000;

type ObservationDependencies = {
  readLiveState?: typeof readSessionLiveState;
  readTranscript?: typeof readSessionTranscript;
  timeoutMs?: number;
};

type ObservationProbe = {
  promise: Promise<SessionSendEffect | null>;
  cancel(): void;
};

function boundedObservationProbe(read: (signal: AbortSignal) => Promise<SessionSendEffect | null>, timeoutMs: number): ObservationProbe {
  const controller = new AbortController();
  let settleBoundary: (value: null) => void = () => undefined;
  const boundary = new Promise<null>((resolve) => { settleBoundary = resolve; });
  const timeout = setTimeout(() => { controller.abort(); settleBoundary(null); }, timeoutMs);
  const promise = Promise.race([read(controller.signal).catch(() => null), boundary]).finally(() => clearTimeout(timeout));
  return {
    promise,
    cancel() { controller.abort(); settleBoundary(null); clearTimeout(timeout); }
  };
}

export function conversationAfterObservedSend(
  conversations: Record<string, LiveConversation>, sessionRef: string, messageRequestId: string,
  evidence: SessionSendEffect, delivery: "admitted" | "unconfirmed"
): Record<string, LiveConversation> {
  const existing = conversations[sessionRef];
  if (!existing || existing.messageRequestId !== messageRequestId) return conversations;
  // WebSocket/canonical evidence is monotonic. A slower transport fallback may
  // report uncertainty after the exact operation has already been admitted;
  // never let that weaker observation hide a running or completed operation.
  if (delivery === "unconfirmed" && (existing.delivery === "admitted" || Boolean(existing.operationRef))) return conversations;
  const marked = markUserMessageDelivery(existing, delivery, evidence.operationRef, new Date().toISOString());
  const complete = delivery === "unconfirmed" || evidence.complete
    || Boolean(evidence.operationRef && existing.operationRef === evidence.operationRef && existing.complete);
  return { ...conversations, [sessionRef]: { ...marked, complete,
    abortable: delivery === "admitted" && !complete && Boolean(evidence.operationRef) } };
}

export async function observeSessionSendEffect(input: {
  sessionRef: string;
  message: string;
  requestedAt: string;
  afterSerial: number;
  priorOperationRef: string | null;
  messageRequestId: string;
  localObservation?: OperationObservation;
  readLocalObservation?: () => OperationObservation | undefined;
}, dependencies: ObservationDependencies = {}): Promise<SessionSendEffect | null> {
  const localEvidence = () => {
    const local = newerOperationObservation(input.readLocalObservation?.() ?? input.localObservation,
      input.afterSerial, input.priorOperationRef, input.messageRequestId);
    return local ? { operationRef: local.operationRef, complete: local.complete } : null;
  };
  const local = localEvidence();
  if (local) return local;
  const timeoutMs = dependencies.timeoutMs ?? SESSION_SEND_OBSERVATION_TIMEOUT_MS;
  const liveState = dependencies.readLiveState ?? readSessionLiveState;
  const transcript = dependencies.readTranscript ?? readSessionTranscript;
  const probes = [
    boundedObservationProbe(async (signal) => {
      const canonical = await liveState(signal);
      const operation = canonical?.state === "ready"
        ? canonical.operations.find((item) => item.sessionRef === input.sessionRef) : undefined;
      return canonicalOperationAfter(operation, input.priorOperationRef, input.messageRequestId);
    }, timeoutMs),
    boundedObservationProbe(async (signal) => {
      const persistedTranscript = await transcript(input.sessionRef, null, 50, signal);
      if (persistedTranscript?.state !== "ready") return null;
      const exact = [...persistedTranscript.items].reverse().find((item) => item.role === "user"
        && item.messageRequestId === input.messageRequestId);
      if (exact) return { operationRef: exact.agentOperationId,
        complete: persistedLiveConversationHasFinal(persistedTranscript.items, input.message,
          { operationRef: exact.agentOperationId, messageRequestId: input.messageRequestId, startedAt: null }) };
      const requested = Date.parse(input.requestedAt);
      const persisted = [...persistedTranscript.items].reverse().find((item) => item.role === "user" && !item.messageRequestId
        && persistedUserTextMatches(item.content.text, input.message) && Date.parse(item.recordedAt) >= requested);
      if (!persisted) return null;
      return { operationRef: persisted.agentOperationId,
        complete: persistedLiveConversationHasFinal(persistedTranscript.items, input.message,
          { operationRef: persisted.agentOperationId, messageRequestId: null, startedAt: input.requestedAt }) };
    }, timeoutMs)
  ];
  const pending = new Map(probes.map((probe, index) => [index, probe.promise.then((evidence) => ({ evidence, index }))]));
  try {
    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);
      if (settled.evidence) return settled.evidence;
      const observedWhileReading = localEvidence();
      if (observedWhileReading) return observedWhileReading;
    }
    return localEvidence();
  } finally {
    for (const probe of probes) probe.cancel();
  }
}
