export function migrationPlan(steps) {
  if (!Array.isArray(steps)) throw new TypeError("steps must be an array");
  const byId = new Map();
  const indexById = new Map();
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step.id !== "string" || !step.id.trim() || typeof step.apply !== "function" || byId.has(step.id) || !Array.isArray(step.dependsOn ?? [])) throw new TypeError("invalid migration step");
    byId.set(step.id, step); indexById.set(step.id, index);
  }
  const remaining = new Map();
  const dependents = new Map(steps.map((step) => [step.id, []]));
  for (const step of steps) {
    const dependencies = new Set(step.dependsOn ?? []);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) throw new TypeError("unknown dependency");
      dependents.get(dependency).push(step.id);
    }
    remaining.set(step.id, dependencies.size);
  }
  const ready = steps.filter((step) => remaining.get(step.id) === 0).map((step) => step.id);
  const result = [];
  while (ready.length) {
    ready.sort((left, right) => indexById.get(left) - indexById.get(right));
    const id = ready.shift();
    result.push(byId.get(id));
    for (const dependent of dependents.get(id)) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (remaining.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (result.length !== steps.length) throw new TypeError("migration cycle");
  return result;
}
