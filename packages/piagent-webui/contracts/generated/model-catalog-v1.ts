/* Generated from schemas/piagent-webui/model-catalog-v1.schema.json. Do not edit. */

export type PiagentWebUIAuthenticatedModelCatalogV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-model-catalog-v1";
  generatedAt: string;
  identity: Identity;
  revision: DomainRevision;
  state: "ready" | "unavailable";
  catalogScope: "authenticated-all" | "session-scoped" | "unavailable";
  effectScope: "session-and-user-default";
  activeModelRef: string | null;
  activeThinkingLevel: NullableThinkingLevel;
  /**
   * @maxItems 300
   */
  models: Model[];
  reasonCode: string | null;
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
export type NullableThinkingLevel = ThinkingLevel | null;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SafeName = string;

export interface DomainRevision {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
}
export interface Model {
  modelRef: string;
  provider: string;
  modelId: string;
  displayName: SafeName;
  reasoning: boolean;
  /**
   * @maxItems 2
   */
  inputCapabilities: [] | ["text" | "image"] | ["text" | "image", "text" | "image"];
  /**
   * @minItems 1
   * @maxItems 7
   */
  supportedThinkingLevels:
    | [ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel]
    | [ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel, ThinkingLevel];
  contextWindow: number;
  maxOutputTokens: number;
}
