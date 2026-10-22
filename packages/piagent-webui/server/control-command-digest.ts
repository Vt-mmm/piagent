import { reviewDigest } from "../../piagent-core/runtime/inspection/review-state-contract.ts";

export function controlActionDigest(command: { action: unknown; identity: unknown; expectedRevisions: unknown; payload: unknown }): string {
  return reviewDigest({ action: command.action, identity: command.identity, expectedRevisions: command.expectedRevisions, payload: command.payload });
}
