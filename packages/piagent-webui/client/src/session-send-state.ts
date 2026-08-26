import type { Receipt } from "../../contracts/generated/session-command-v1.ts";

export type OperationObservation = { serial: number; operationRef: string; messageRequestId?: string | null; complete: boolean };
export type SessionSendDisposition = "confirmed" | "observed" | "unconfirmed" | "rejected";

export class GatewayCommandTransportError extends Error {
  readonly effectMayHaveOccurred: boolean;
  constructor(code: string, effectMayHaveOccurred: boolean) {
    super(code); this.name = "GatewayCommandTransportError"; this.effectMayHaveOccurred = effectMayHaveOccurred;
  }
}

export function gatewayCommandMayHaveEffect(error: unknown, commandSubmitted: boolean): boolean {
  return error instanceof GatewayCommandTransportError ? error.effectMayHaveOccurred : commandSubmitted;
}

export function newerOperationObservation(observation: OperationObservation | undefined,
  afterSerial: number, priorOperationRef: string | null = null, messageRequestId: string | null = null): OperationObservation | null {
  if (!observation || observation.serial <= afterSerial || observation.operationRef === priorOperationRef) return null;
  if (messageRequestId && observation.messageRequestId && observation.messageRequestId !== messageRequestId) return null;
  return observation;
}

export function canonicalOperationAfter(operation: { operationRef: string; messageRequestId?: string | null; abortable: boolean } | undefined,
  priorOperationRef: string | null, messageRequestId: string | null = null): { operationRef: string; complete: false } | null {
  return operation && operation.operationRef !== priorOperationRef
    && !(messageRequestId && operation.messageRequestId && operation.messageRequestId !== messageRequestId)
    ? { operationRef: operation.operationRef, complete: false } : null;
}

export function sessionSendDisposition(receipt: Receipt | null,
  evidence: { operationRef: string | null; complete: boolean } | null): SessionSendDisposition {
  // Runtime or durable transcript evidence wins over a contradictory transport
  // result: the operation exists, so presenting the message as rejected would
  // invite a duplicate run.
  if (evidence) return "observed";
  if (receipt?.phase === "settled" || receipt?.phase === "accepted") return "confirmed";
  if (receipt?.phase === "rejected") return "rejected";
  return "unconfirmed";
}
