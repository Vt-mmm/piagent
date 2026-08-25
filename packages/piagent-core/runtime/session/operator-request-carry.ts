import type { TaskContract } from "../../extensions/guard-types.ts";
import { operatorRequestDigest } from "../../extensions/task-state.js";

export const OPERATOR_REQUEST_CARRY_LABEL = "Authoritative operator request (redacted, lossless):";
export const LOSSLESS_TASK_TRUTH_FIXED_RESERVE_CHARS = 1_600;

export function validOperatorRequestTruth(task?: TaskContract): boolean {
  return typeof task?.operatorRequest === "string"
    && task.operatorRequest.length > 0
    && task.operatorRequestDigest === operatorRequestDigest(task.operatorRequest);
}

export function operatorRequestCarryLines(task?: TaskContract): string[] {
  if (!validOperatorRequestTruth(task)) return [];
  return [
    `${OPERATOR_REQUEST_CARRY_LABEL} ${task!.operatorRequestDigest}`,
    task!.operatorRequest!,
    "End authoritative operator request."
  ];
}

export function losslessOperatorRequestFitsWithin(
  task: TaskContract | undefined,
  maximum: number,
  fixedReserve = LOSSLESS_TASK_TRUTH_FIXED_RESERVE_CHARS
): boolean {
  const operatorTruth = operatorRequestCarryLines(task);
  const verifiers = (task?.verifyCommands ?? []).map((command, index) => `${index + 1}. ${command}`);
  const authoritativeTruth = operatorTruth.length > 0
    ? operatorTruth
    : task
      ? [
          `Goal: ${task.summary}`,
          `Expected output: ${task.expectedOutput}`,
          "Acceptance criteria:",
          ...task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`)
        ]
      : [];
  return [
    ...authoritativeTruth,
    "Exact verifier commands:",
    ...verifiers
  ].join("\n").length + fixedReserve <= maximum;
}
