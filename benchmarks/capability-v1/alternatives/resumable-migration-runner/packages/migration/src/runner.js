function validatePlannedSteps(steps) {
  if (!Array.isArray(steps)) throw new TypeError("steps must be an array");
  const byId = new Map();
  for (const step of steps) {
    if (!step || Array.isArray(step) || typeof step.id !== "string" || !step.id.trim() || typeof step.apply !== "function" || byId.has(step.id) || !Array.isArray(step.dependsOn ?? [])) {
      throw new TypeError("invalid migration step");
    }
    byId.set(step.id, step);
  }

  const visited = new Set();
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (typeof dependency !== "string" || !byId.has(dependency) || !visited.has(dependency)) {
        throw new TypeError("steps must be in migration-plan order");
      }
    }
    visited.add(step.id);
  }
  return byId;
}

export async function runMigration({ steps, checkpoint, apply }) {
  if (!checkpoint || typeof checkpoint.read !== "function" || typeof checkpoint.write !== "function" || typeof apply !== "function") {
    throw new TypeError("invalid migration runner input");
  }
  const byId = validatePlannedSteps(steps);
  const stored = await checkpoint.read();
  if (!Array.isArray(stored) || stored.some((id) => typeof id !== "string" || !byId.has(id)) || new Set(stored).size !== stored.length) {
    throw new TypeError("invalid migration checkpoint");
  }

  const completed = [...stored];
  const completedIds = new Set(completed);
  for (const step of steps) {
    if (completedIds.has(step.id)) continue;
    await apply(step);
    completedIds.add(step.id);
    completed.push(step.id);
    await checkpoint.write(completed.slice());
  }
  return { completed: completed.slice() };
}
