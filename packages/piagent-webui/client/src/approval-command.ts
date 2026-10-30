import type { ApprovalDecision, ApprovalRequest } from "../../contracts/generated/approval-v1.ts";

// The member's four answers: allow once, allow the same exact action for the
// session, deny, deny and stop the turn.
export type ApprovalAnswer = "allow" | "session" | "deny" | "stop";
// A handoff (push, pull request, publish, deploy…) and a waiver of checks are approved one at a time.
export const sessionGrantable = (request: ApprovalRequest) => !/handoff|waiver/.test(String(request.action.requestedScope));

export function createApprovalDecision(request: ApprovalRequest, answer: ApprovalAnswer): ApprovalDecision {
  const decision = answer === "allow" || answer === "session" ? "allow" : "deny";
  return { schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "decision", approvalRef: request.approvalRef,
    decisionId: `decision.${crypto.randomUUID()}`, decisionToken: request.decisionToken, identity: structuredClone(request.identity),
    actionDigest: request.action.actionDigest, expectedRevisions: structuredClone(request.expectedRevisions), decision, reason: null,
    decidedAt: new Date().toISOString(), expiresAt: request.expiresAt, decisionSurface: "webui", executor: "pi-guard", directExecution: false,
    ...(answer === "session" ? { scope: "session" as const } : answer === "stop" ? { stop: true } : {}) };
}
