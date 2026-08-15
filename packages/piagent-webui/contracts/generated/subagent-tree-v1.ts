/* Generated from schemas/piagent-webui/subagent-tree-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedSubagentOwnershipTreeV1 = {
  identity?: {
    taskId?: string;
    taskRunId?: string;
    agentOperationId?: null;
    toolCallId?: null;
    [k: string]: any;
  };
  [k: string]: any;
} & {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-subagent-tree-v1";
  generatedAt: string;
  identity: Identity;
  runRef: string;
  state: "ready" | "unavailable";
  treeRevision: string | null;
  evidenceState: "complete" | "partial" | "aggregate-only" | "missing" | "unknown";
  orchestration: Orchestration;
  parent: Parent | null;
  /**
   * @maxItems 64
   */
  children: Child[];
  writer: Writer;
  nestedLineage: NestedLineage;
  summary: Summary;
  /**
   * @maxItems 8
   */
  warnings:
    | []
    | [Warning]
    | [Warning, Warning]
    | [Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning, Warning]
    | [Warning, Warning, Warning, Warning, Warning, Warning, Warning, Warning];
  health: Health;
};
export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};

export interface Orchestration {
  mode: "solo-first" | "bounded-subagents" | "parallel-readonly" | "unknown";
  subagents: "not-used" | "optional" | "used" | "unknown";
}
export interface Parent {
  nodeRef: string;
  lifecycleState: "active" | "terminal" | "unknown";
  budgetTerminal: boolean | null;
  mergeOwner: "parent";
}
export interface Child {
  nodeRef: string;
  parentRef: string;
  role: "retriever" | "scout" | "planner" | "worker" | "reviewer" | "oracle" | "researcher";
  authority: "read-only" | "single-writer";
  lifecycleState: "active" | "succeeded" | "failed" | "cancelled" | "orphaned";
  reservedAt: string;
  expiresAt: string;
  completedAt: string | null;
  currentWriter: boolean;
  result: Result;
}
export interface Result {
  state: "accepted" | "rejected" | "stale-result" | "not-recorded";
  disposition: string | null;
  calls: number | null;
  tokens: number | null;
}
export interface Writer {
  state: "parent" | "helper" | "unknown";
  ownerNodeRef: string | null;
}
export interface NestedLineage {
  state: "unavailable";
  reasonCode: "no-durable-nested-lineage";
}
export interface Summary {
  total: number;
  active: number;
  completed: number;
  staleResults: number;
  readOnly: number;
  singleWriter: number;
}
export interface Warning {
  code: "helper-budget-missing" | "expired-helper-derived-orphan" | "helper-receipt-unmatched";
  count: number;
  message: string;
}
