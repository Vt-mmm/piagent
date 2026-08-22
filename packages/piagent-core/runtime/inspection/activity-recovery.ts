import type { ActivityInspectorEvent } from "../product/activity-inspector.ts";

const RECOVERY_WINDOW_MS = 15 * 60 * 1_000;
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "command"]);
const MUTATION_TOOLS = /(?:^|[._-])(?:apply[_-]?patch|edit|write|create[_-]?file|replace)(?:$|[._-])/i;

export type ActivityRecovery = {
  recoveredAt: string;
  recoveryToolCallId: string;
  recoveryToolName: string;
  exitCode: number | null;
  exitCodeExact: boolean;
};

function resultFailed(event: ActivityInspectorEvent | undefined): boolean {
  return Boolean(event && (event.isError === true || typeof event.exitCode === "number" && event.exitCode !== 0));
}

function time(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\\", "/").replace(/\s+/g, " ").trim() : "";
}

function family(toolName: unknown): "read" | "mutation" | "shell" | "other" {
  const value = String(toolName ?? "").toLowerCase();
  if (SHELL_TOOLS.has(value)) return "shell";
  if (MUTATION_TOOLS.test(value)) return "mutation";
  if (/(?:^|[._-])(?:read|document[_-]?read)(?:$|[._-])/.test(value)) return "read";
  return "other";
}

function likelyCorrectedReadTarget(failed: ActivityInspectorEvent, candidate: ActivityInspectorEvent): boolean {
  if (family(failed.toolName) !== "read" || family(candidate.toolName) !== "read") return false;
  const failedPath = normalized(failed.targetPath).toLowerCase();
  const candidatePath = normalized(candidate.targetPath).toLowerCase();
  const failedSlash = failedPath.lastIndexOf("/"), candidateSlash = candidatePath.lastIndexOf("/");
  if (!failedPath || !candidatePath || failedPath.slice(0, failedSlash) !== candidatePath.slice(0, candidateSlash)) return false;
  const failedName = failedPath.slice(failedSlash + 1), candidateName = candidatePath.slice(candidateSlash + 1);
  const failedExtension = failedName.includes(".") ? failedName.slice(failedName.lastIndexOf(".")) : "";
  const candidateExtension = candidateName.includes(".") ? candidateName.slice(candidateName.lastIndexOf(".")) : "";
  if (failedExtension !== candidateExtension) return false;
  const tokens = (value: string) => new Set(value.slice(0, value.length - failedExtension.length).split(/[^a-z0-9]+/).filter(Boolean));
  const failedTokens = tokens(failedName), candidateTokens = tokens(candidateName);
  const overlap = [...failedTokens].filter((token) => candidateTokens.has(token)).length;
  return overlap >= 2 && overlap === Math.min(failedTokens.size, candidateTokens.size);
}

function sameLogicalTarget(failed: ActivityInspectorEvent, candidate: ActivityInspectorEvent): boolean {
  const failedPath = normalized(failed.targetPath), candidatePath = normalized(candidate.targetPath);
  if (failedPath && candidatePath && failedPath === candidatePath) {
    const failedFamily = family(failed.toolName), candidateFamily = family(candidate.toolName);
    return failedFamily === candidateFamily || failedFamily === "read" && candidateFamily === "mutation";
  }
  const failedCommand = normalized(failed.command), candidateCommand = normalized(candidate.command);
  return Boolean(failedCommand && candidateCommand && failedCommand === candidateCommand
    && family(failed.toolName) === "shell" && family(candidate.toolName) === "shell");
}

export function recoveredToolCalls(events: readonly ActivityInspectorEvent[]): ReadonlyMap<string, ActivityRecovery> {
  const results = new Map<string, { event: ActivityInspectorEvent; order: number }>();
  for (let order = 0; order < events.length; order += 1) {
    const event = events[order];
    if (event?.event === "tool_result" && event.toolCallId) results.set(event.toolCallId, { event, order });
  }
  const segments = new Map<number, number>();
  let segment = 0;
  for (let order = 0; order < events.length; order += 1) {
    if (events[order]?.event === "user_input") segment += 1;
    segments.set(order, segment);
  }
  const calls = events.map((event, order) => ({ event, order }))
    .filter((entry) => entry.event?.event === "tool_call" && Boolean(entry.event.toolCallId));
  const recovered = new Map<string, ActivityRecovery>();
  for (let failedCallIndex = 0; failedCallIndex < calls.length; failedCallIndex += 1) {
    const failedCall = calls[failedCallIndex];
    const failedResult = results.get(failedCall.event.toolCallId!);
    if (!failedResult || !resultFailed(failedResult.event)) continue;
    const failedAt = time(failedResult.event.recordedAt ?? failedCall.event.recordedAt);
    const match = calls.find((candidate, candidateIndex) => {
      if (candidate.order <= failedResult.order || segments.get(candidate.order) !== segments.get(failedCall.order)) return false;
      const candidateResult = results.get(candidate.event.toolCallId!);
      if (!candidateResult || resultFailed(candidateResult.event)) return false;
      const recoveredAt = time(candidateResult.event.recordedAt ?? candidate.event.recordedAt);
      return Number.isFinite(failedAt) && Number.isFinite(recoveredAt) && recoveredAt >= failedAt
        && recoveredAt - failedAt <= RECOVERY_WINDOW_MS
        && (sameLogicalTarget(failedCall.event, candidate.event)
          || candidateIndex === failedCallIndex + 1 && likelyCorrectedReadTarget(failedCall.event, candidate.event));
    });
    if (!match) continue;
    const recoveryResult = results.get(match.event.toolCallId!)!.event;
    recovered.set(failedCall.event.toolCallId!, {
      recoveredAt: String(recoveryResult.recordedAt ?? match.event.recordedAt),
      recoveryToolCallId: match.event.toolCallId!,
      recoveryToolName: String(match.event.toolName ?? "unknown"),
      exitCode: typeof recoveryResult.exitCode === "number" ? recoveryResult.exitCode : null,
      exitCodeExact: recoveryResult.exitCodeExact === true
    });
  }
  return recovered;
}
