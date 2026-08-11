function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new TypeError("steps must be an array");
  const byId = new Map();
  for (const step of steps) {
    if (!step || Array.isArray(step) || typeof step.id !== "string" || !step.id.trim() || typeof step.apply !== "function" || byId.has(step.id) || !Array.isArray(step.dependsOn ?? [])) {
      throw new TypeError("invalid migration step");
    }
    byId.set(step.id, step);
  }
  for (const step of steps) {
    if ((step.dependsOn ?? []).some((dependency) => typeof dependency !== "string" || !byId.has(dependency))) {
      throw new TypeError("unknown migration dependency");
    }
  }
  return byId;
}

export function migrationPlan(steps) {
  validateSteps(steps);
  const pending = new Set(steps.map((step) => step.id));
  const completed = new Set();
  const result = [];

  while (pending.size) {
    const next = steps.find((step) => pending.has(step.id) && (step.dependsOn ?? []).every((dependency) => completed.has(dependency)));
    if (!next) throw new TypeError("migration cycle");
    result.push(next);
    completed.add(next.id);
    pending.delete(next.id);
  }
  return result;
}
