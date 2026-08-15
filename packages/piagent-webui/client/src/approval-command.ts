import type { ApprovalDecision, ApprovalRequest } from "../../contracts/generated/approval-v1.ts";

export function createApprovalDecision(request: ApprovalRequest, answer: "allow" | "deny"): ApprovalDecision {
  return { schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "decision", approvalRef: request.approvalRef,
    decisionId: `decision.${crypto.randomUUID()}`, decisionToken: request.decisionToken, identity: structuredClone(request.identity),
    actionDigest: request.action.actionDigest, expectedRevisions: structuredClone(request.expectedRevisions), decision: answer, reason: null,
    decidedAt: new Date().toISOString(), expiresAt: request.expiresAt, decisionSurface: "webui", executor: "pi-guard", directExecution: false };
}
