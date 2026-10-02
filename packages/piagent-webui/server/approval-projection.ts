// Gateway and extension sessions publish the same approval contract.
export function projectApprovalState(snapshot: any, approval?: { revision: string | null; summary: Record<string, unknown> }) {
  if (!approval?.revision) return;
  snapshot.revision.approvalRevision = approval.revision;
  snapshot.approvals = structuredClone(approval.summary);
  snapshot.session.approvalState = approval.summary.state;
  snapshot.capabilities.capabilities.approve = { status: "available", version: 1, reason: null,
    decisions: ["allow", "deny"], arbitration: "first-valid-cas" };
}
