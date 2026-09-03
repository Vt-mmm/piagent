export function classifyCodexAttemptOutcome({ eventOutcome, scenarioKind, changedFiles }) {
  if (eventOutcome?.runValidity === "valid" && ["agent_tool_failure", "agent_task_failure"].includes(eventOutcome.failureClass)) {
    return {
      failureClass: eventOutcome.failureClass,
      reason: eventOutcome.reasonCodes?.[0] ?? "codex-event-failure",
      countsTowardQuality: true,
      countsTowardUsage: true
    };
  }
  if (eventOutcome?.runValidity === "valid" && scenarioKind === "source-change"
    && Array.isArray(changedFiles) && changedFiles.length === 0) {
    return {
      failureClass: "agent_task_failure",
      reason: "mutation-produced-no-file-change",
      countsTowardQuality: true,
      countsTowardUsage: true
    };
  }
  return null;
}
