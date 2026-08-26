import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  RetrievalEvidenceRuntime,
  type RetrievalEvidenceCheckpoint,
  type RetrievalEvidenceObservation
} from "../session/retrieval-evidence-runtime.ts";
import { appendToolResultText, isPlainRecord } from "./tool-result-value-helpers.ts";

export function observeRetrievalResult(input: {
  runtime: RetrievalEvidenceRuntime;
  ctx: ExtensionContext;
  observation: RetrievalEvidenceObservation;
  turnId?: string;
}): RetrievalEvidenceCheckpoint | undefined {
  return input.runtime.observe(input.ctx, input.observation, input.turnId);
}

export function attachRetrievalCheckpoint(input: {
  checkpoint?: RetrievalEvidenceCheckpoint;
  content: unknown;
  details: unknown;
  ctx: ExtensionContext;
  turnId?: string;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
}): { content: unknown; details: unknown; changed: boolean } {
  if (!input.checkpoint) return { content: input.content, details: input.details, changed: false };
  const details = isPlainRecord(input.details)
    ? { ...input.details, piagentRetrievalCheckpoint: input.checkpoint }
    : { ...(input.details === undefined ? {} : { value: input.details }), piagentRetrievalCheckpoint: input.checkpoint };
  input.telemetry(input.ctx, {
    event: "retrieval_evidence_checkpoint",
    turnId: input.turnId,
    ...input.checkpoint,
    text: undefined
  });
  return {
    content: appendToolResultText(input.content, input.checkpoint.text),
    details,
    changed: true
  };
}
