/* Generated from schemas/piagent-webui/session-catalog-v1.schema.json. Do not edit. */

export type PiagentGatewayDurableSessionCatalogV1 = Catalog | SessionDetail;
export type Catalog = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-session-catalog-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  state: "ready" | "unavailable";
  catalogRevision: string | null;
  /**
   * @maxItems 200
   */
  sessions: SessionRow[];
  page: Page;
  reasonCode: string | null;
};
export type SessionRow = {
  [k: string]: any;
} & {
  sessionRef: string;
  projectRef: string;
  title: string;
  projectLabel: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  state:
    | "offline"
    | "gateway-starting"
    | "gateway-owned"
    | "terminal-owned"
    | "handoff-pending"
    | "recovery-required"
    | "archived";
  liveState: "offline" | "idle" | "running" | "paused" | "waiting-approval" | "uncertain";
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  composerAvailable: boolean;
  needsAttention: boolean;
  modelLabel: string | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "unknown";
  contextUsage: ContextUsage;
  task: null | {
    taskRef: string;
    summary: string;
    outcome: "pending" | "completed" | "blocked" | "partial" | "failed" | "unknown";
    progressCompleted: number;
    progressTotal: number;
  };
  owner: Owner;
  sessionRevision: string;
  reasonCode: string | null;
};
export type ContextUsage = {
  [k: string]: any;
} & {
  usedTokens: number | null;
  contextWindow: number | null;
  ratio: number | null;
  state: "known" | "unknown";
};
export type Owner =
  | {
      kind: "none";
      ownerEpoch: null;
      gatewayInstanceRef: null;
      runtimeInstanceRef: null;
      continuity: "released" | "unknown";
    }
  | {
      kind: "gateway";
      ownerEpoch: string;
      gatewayInstanceRef: string;
      runtimeInstanceRef: string;
      continuity: "exact" | "uncertain";
    }
  | {
      kind: "terminal";
      ownerEpoch: string;
      gatewayInstanceRef: string;
      runtimeInstanceRef: string;
      continuity: "exact" | "uncertain";
    };

export interface Page {
  limit: number;
  returned: number;
  total: number;
  nextCursor: string | null;
  truncated: boolean;
}
export interface SessionDetail {
  schemaVersion: 1;
  version: "piagent-session-detail-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  catalogRevision: string;
  session: SessionRow;
}
