import { migrationPlan } from "./plan.js";

export async function runMigration({ steps, checkpoint, apply }) {
  if (!Array.isArray(steps) || !checkpoint || typeof checkpoint.read !== "function" || typeof checkpoint.write !== "function" || typeof apply !== "function") throw new TypeError("invalid migration runner input");
  const planned = migrationPlan(steps);
  if (planned.some((step, index) => step.id !== steps[index].id)) throw new TypeError("steps must be in stable migration-plan order");
  const known = new Set(steps.map((step) => step.id));
  const stored = await checkpoint.read();
  if (!Array.isArray(stored) || stored.some((id) => !known.has(id))) throw new TypeError("invalid migration checkpoint");
  const completed = [...stored]; const completedSet = new Set(completed);
  for (const step of steps) {
    if (completedSet.has(step.id)) continue;
    await apply(step);
    completed.push(step.id); completedSet.add(step.id);
    await checkpoint.write([...completed]);
  }
  return { completed: [...completed] };
}
