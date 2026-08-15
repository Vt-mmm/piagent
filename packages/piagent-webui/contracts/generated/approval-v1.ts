/* Generated from schemas/piagent-webui/approval-v1.schema.json. Do not edit. */

export type PiagentWebUIExactActionApprovalWireRecordsV1 = ApprovalRequest | ApprovalDecision | ApprovalReceipt;
export type ApprovalRequest = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-approval-v1";
  recordType: "request";
  approvalRef: string;
  decisionToken: OneTimeDecisionToken;
  identity: ApprovalIdentity;
  action: ApprovalAction;
  expectedRevisions: ExpectedRevisions;
  state: "waiting";
  requestedAt: string;
  expiresAt: string;
  executor: "pi-guard";
  directExecution: false;
};
export type OneTimeDecisionToken = string;
export type ApprovalAction = {
  [k: string]: any;
} & {
  kind: ApprovalActionKind;
  preconditionClass: PreconditionClass;
  toolName: string;
  actionDigest: string;
  canonicalization: "digest-bound-action-v1";
  previewPolicy: "redacted-no-secrets-v1";
  commandPreview: NullableLongDisplayText;
  parameterPreview: BoundedRedactedPreview;
  targetEvidence: TargetEvidence;
  cwdRef: string;
  cwdDisplay: string | null;
  /**
   * @maxItems 32
   */
  targetRefs: string[];
  /**
   * @maxItems 32
   */
  targetPaths: string[];
  /**
   * @maxItems 32
   */
  targetSummaries: string[];
  providerRef: string | null;
  urlOrigin: SafeUrlOrigin | null;
  requestedScope: string;
  reason: string;
  riskClass: "low" | "medium" | "high" | "critical";
  consequences: {
    allow: string;
    deny: string;
  };
  redaction: Redaction;
};
export type ApprovalActionKind =
  | "external-provider-action"
  | "filesystem-write"
  | "filesystem-delete"
  | "workspace-patch"
  | "source-stage"
  | "source-unstage"
  | "source-revert";
export type PreconditionClass = "runtime-only" | "workspace-tree" | "workspace-index";
export type NullableLongDisplayText = BoundedRedactedPreview | null;
export type BoundedRedactedPreview = string;
export type TargetEvidence =
  | {
      state: "provided";
      reasonCode: null;
    }
  | {
      state: "redacted";
      reasonCode: string;
    };
export type SafeUrlOrigin = string;
export type Redaction = {
  [k: string]: any;
} & {
  applied: boolean;
  valuesRemoved: number;
  truncated: boolean;
};
export type ApprovalReceipt = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-approval-v1";
  recordType: "receipt";
  approvalRef: string;
  decisionId: string | null;
  identity: ApprovalIdentity;
  actionDigest: string;
  state: "resolved" | "expired" | "cancelled";
  decision: ("allow" | "deny") | null;
  winnerSurface: "webui" | "terminal" | "runtime-expiry" | "runtime-control" | "runtime-restart";
  resolutionReason: string | null;
  resolvedAt: string;
  preRevisions: ExpectedRevisions;
  postRevisions: ReceiptRevisions;
  permit: Permit;
  deduplicated: boolean;
  auditRef: string;
  executor: "pi-guard";
  directExecution: false;
};
export type Permit = PermitNotIssued | PermitProvisional | PermitConsumed | PermitCancelled;

export interface ApprovalIdentity {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string;
  taskRunId: string;
  agentOperationId: string;
  toolCallId: string;
}
export interface ExpectedRevisions {
  runtimeRevision: string;
  taskRevision: string;
  controlRevision: string;
  approvalRevision: string;
  treePrecondition: null | TreePrecondition;
}
export interface TreePrecondition {
  workspaceRevision: string;
  indexRevision: string | null;
  preimageDigest: string;
}
export interface ApprovalDecision {
  schemaVersion: 1;
  version: "piagent-webui-approval-v1";
  recordType: "decision";
  approvalRef: string;
  decisionId: string;
  decisionToken: OneTimeDecisionToken;
  identity: ApprovalIdentity;
  actionDigest: string;
  expectedRevisions: ExpectedRevisions;
  decision: "allow" | "deny";
  reason: string | null;
  decidedAt: string;
  expiresAt: string;
  decisionSurface: "webui";
  executor: "pi-guard";
  directExecution: false;
}
export interface ReceiptRevisions {
  runtimeRevision: string;
  taskRevision: string;
  controlRevision: string;
  approvalRevision: string;
}
export interface PermitNotIssued {
  status: "not-issued";
  issuedAt: null;
  consumedAt: null;
  reasonCode: string | null;
}
export interface PermitProvisional {
  status: "provisional";
  issuedAt: string;
  consumedAt: null;
  reasonCode: null;
}
export interface PermitConsumed {
  status: "consumed";
  issuedAt: string;
  consumedAt: string;
  reasonCode: null;
}
export interface PermitCancelled {
  status: "cancelled" | "expired";
  issuedAt: string | null;
  consumedAt: null;
  reasonCode: string;
}
