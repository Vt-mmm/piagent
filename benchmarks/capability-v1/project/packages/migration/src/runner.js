export async function runMigration({ steps, checkpoint, apply }) {
  for (const step of steps) await apply(step);
  return checkpoint;
}
