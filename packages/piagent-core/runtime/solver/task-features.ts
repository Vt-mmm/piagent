import crypto from "node:crypto";

import { classifyContextTask } from "../../extensions/context-engine.js";
import { redactSensitiveText } from "../../security/sensitive-data.js";
import type { TaskFeatures, WorkflowIntent } from "./solver-types.ts";
import { validateTaskFeatures } from "./solver-types.ts";

export type TaskFeatureInput = {
  request: string;
  workflowIntent?: WorkflowIntent;
  changeMode?: TaskFeatures["changeMode"];
  riskLane?: TaskFeatures["riskLane"];
  riskSignals?: string[];
  ambiguity?: TaskFeatures["ambiguity"];
  scopeEstimate?: TaskFeatures["scopeEstimate"];
  profileMode?: string | null;
  projectShape?: string[];
  gitReady?: boolean | null;
  dirtyTree?: boolean | null;
  verifierReady?: boolean | null;
  contextPressure?: number | null;
  activeTaskState?: TaskFeatures["activeTaskState"];
  runtimeSnapshotDigest?: string | null;
  runtimeCapabilitiesKnown?: boolean;
  userPinnedProvider?: string | null;
  userPinnedModel?: string | null;
  userPinnedEffort?: string | null;
  protectedTarget?: boolean;
};

function intent(request: string): WorkflowIntent {
  const value = request.toLowerCase().replace(/(?:^|\s)(?:[.\w-]+\/)+[\w.-]+/g, " ");
  const lead = value.split(/[.!?\n]/, 1)[0];
  const primary = lead.trim();
  if (/^(?:review|audit)\b|^(?:đánh giá|kiểm tra code|rà soát)/u.test(primary)) return "review";
  if (/^(?:plan|planning)\b|^(?:lập kế hoạch|kế hoạch)/u.test(primary)) return "plan";
  if (/^(?:diagnos(?:e|is)|investigate|debug|read[- ]only)\b|^(?:chẩn đoán|điều tra|phân tích lỗi|chỉ đọc)/u.test(primary)) return "diagnose";
  if (/^(?:scout|research|inspect|explore)\b|^(?:khảo sát|nghiên cứu|xem xét)/u.test(primary)) return "scout";
  if (/^(?:implement|fix|repair|correct|replace|build|add|change|update|refactor|create|make|erase)\b|^(?:sửa|xây|thêm|đổi|cập nhật|triển khai)/u.test(primary)) return "implement";
  if (/\b(review|audit)\b|(?:đánh giá|kiểm tra code|rà soát)/u.test(lead)) return "review";
  if (/\b(plan|planning)\b|(?:lập kế hoạch|kế hoạch)/u.test(lead)) return "plan";
  if (/\b(diagnos(?:e|is)|investigate|debug|root cause|read[- ]only)\b|(?:chẩn đoán|điều tra|phân tích lỗi|chỉ đọc)/u.test(lead)) return "diagnose";
  if (/\b(scout|research|inspect|explore)\b|(?:khảo sát|nghiên cứu|xem xét)/u.test(lead)) return "scout";
  if (/\b(implement|fix|repair|correct|replace|build|add|change|update|refactor|create|make|erase)\b|(?:sửa|xây|thêm|đổi|cập nhật|triển khai)/u.test(lead)) return "implement";
  return "unknown";
}

function normalizedNames(values: readonly unknown[] | undefined, max = 16): string[] {
  return [...new Set((values ?? []).map((value) => {
    const redacted = redactSensitiveText(String(value ?? "").trim());
    return (redacted.redacted ? "redacted" : redacted.text).toLowerCase().replace(/[^a-z0-9._:/-]+/g, "-");
  }).filter(Boolean))]
    .sort()
    .slice(0, max);
}

function nullableName(value: unknown): string | null {
  const redacted = redactSensitiveText(String(value ?? "").trim());
  const clean = (redacted.redacted ? "redacted" : redacted.text).replace(/[^a-z0-9._:/-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  return clean || null;
}

function stableHash(value: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function extractTaskFeatures(input: TaskFeatureInput): TaskFeatures {
  const request = String(input.request ?? "");
  const signal = classifyContextTask(request);
  const workflowIntent = input.workflowIntent ?? intent(request);
  const lower = request.toLowerCase();
  const externalAction = /\b(push|publish|deploy|release|open (?:a )?pr|create (?:an )?issue|send|upload)\b|\b(?:phát hành|triển khai production|gửi ra ngoài)\b/u.test(lower);
  const destructiveAction = /\b(rm\s+-rf|reset\s+--hard|drop\s+(?:table|database)|delete all|destroy|wipe|erase|remove every trace)\b|(?:xóa hết|xoá hết|hủy dữ liệu)/u.test(lower);
  const permissionExpansion = /\b(grant|elevate|permission expansion|widen permissions?)\b|(?:cấp quyền|mở rộng quyền)/u.test(lower);
  const riskSignals = normalizedNames([
    ...(input.riskSignals ?? []),
    ...(externalAction ? ["external-action"] : []),
    ...(destructiveAction ? ["destructive-action"] : []),
    ...(permissionExpansion ? ["permission-expansion"] : []),
    ...(input.protectedTarget ? ["protected-target"] : []),
    ...(signal.lane === "high-risk" ? ["classifier-high-risk"] : [])
  ]);
  const explicitPathCount = Math.min(1000, signal.paths.length);
  const inferredAmbiguity: TaskFeatures["ambiguity"] = /\b(anything|whatever|somehow|figure it out|everywhere)\b|\b(?:tùy|không rõ|mọi nơi)\b/u.test(lower)
    ? "high"
    : explicitPathCount > 0 ? "low" : workflowIntent === "unknown" ? "high" : "medium";
  const inferredScope: TaskFeatures["scopeEstimate"] = /\b(entire|whole|all (?:files|services)|repo-wide|platform-wide)\b|\b(?:toàn bộ|cả repo)\b/u.test(lower)
    ? "broad"
    : explicitPathCount === 1 ? "tiny" : explicitPathCount > 1 && explicitPathCount <= 4 ? "bounded" : explicitPathCount > 4 ? "broad" : "unknown";
  const changeMode = input.changeMode ?? (workflowIntent === "plan" ? "plan-only" : ["review", "diagnose", "scout"].includes(workflowIntent) ? "read-only" : workflowIntent === "implement" ? "source-change" : "unknown");
  const payload = {
    schemaVersion: 1 as const,
    workflowIntent,
    changeMode,
    riskLane: input.riskLane ?? (riskSignals.length > 0 ? "high-risk" as const : signal.lane === "tiny" ? "tiny" as const : "normal" as const),
    riskSignals,
    ambiguity: input.ambiguity ?? inferredAmbiguity,
    explicitPathCount,
    scopeEstimate: input.scopeEstimate ?? inferredScope,
    profileMode: nullableName(input.profileMode),
    projectShape: normalizedNames(input.projectShape),
    gitReady: input.gitReady ?? null,
    dirtyTree: input.dirtyTree ?? null,
    verifierReady: input.verifierReady ?? null,
    contextPressure: typeof input.contextPressure === "number" && Number.isFinite(input.contextPressure)
      ? Math.max(0, Math.min(1, input.contextPressure)) : null,
    activeTaskState: input.activeTaskState ?? "unknown" as const,
    runtimeSnapshotDigest: input.runtimeSnapshotDigest ?? null,
    runtimeCapabilitiesKnown: input.runtimeCapabilitiesKnown ?? false,
    userPinnedProvider: nullableName(input.userPinnedProvider),
    userPinnedModel: nullableName(input.userPinnedModel),
    userPinnedEffort: nullableName(input.userPinnedEffort),
    protectedTarget: input.protectedTarget ?? false,
    externalAction,
    destructiveAction,
    permissionExpansion
  };
  return validateTaskFeatures({ ...payload, featureHash: stableHash(payload) });
}
