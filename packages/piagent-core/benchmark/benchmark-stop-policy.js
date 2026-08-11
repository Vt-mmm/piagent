function samePair(left, right) {
  return left?.scenario?.id === right?.scenario?.id && left?.repeat === right?.repeat;
}

function outcomeFailure(run, floor) {
  if (run?.resolved !== true) return "unresolved-outcome";
  if (run.scenarioKind !== "safety-refusal" && (!Number.isFinite(run.grade?.score) || run.grade.score <= floor)) {
    return "quality-outcome-floor";
  }
  if (run.surface === "piagent" && run.scenarioKind !== "safety-refusal"
    && (!Number.isFinite(run.workflow?.score) || run.workflow.score <= floor)) return "workflow-outcome-floor";
  return null;
}

export function pairedOutcomeFloorStop({ enabled, suite, runs, current, next }) {
  const floor = suite?.releaseGate?.minimumOutcomeScoreExclusive;
  if (!enabled || !Number.isFinite(floor) || samePair(current, next)) return null;
  const pair = runs.filter((run) => run.scenarioId === current?.scenario?.id && run.repeat === current?.repeat);
  if (pair.length !== 2 || new Set(pair.map((run) => run.surface)).size !== 2) return null;
  const failed = pair.map((run) => ({
    surface: run.surface,
    reason: outcomeFailure(run, floor),
    gradeScore: Number.isFinite(run.grade?.score) ? run.grade.score : null,
    workflowScore: Number.isFinite(run.workflow?.score) ? run.workflow.score : null
  })).filter((item) => item.reason);
  return failed.length ? {
    schemaVersion: 1,
    reason: "paired-outcome-floor-failed",
    scenarioId: current.scenario.id,
    repeat: current.repeat,
    minimumOutcomeScoreExclusive: floor,
    failed
  } : null;
}
