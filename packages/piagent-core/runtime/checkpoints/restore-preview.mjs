import { createHash } from 'node:crypto';

export const checkpointDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Compare each file against the virtual result of undoing newer turns. This
// preserves member edits between turns without writing preview trees or files.
export async function previewCheckpointRestore(git, points, targetId, busy, memberEdits = _since => new Set()) {
  const revision = checkpointDigest(points);
  const index = points.findIndex(point => point.id === targetId);
  const base = { targetId, revision, tree: null, steps: [], files: [], conflicts: [], stoppedAt: null };
  if (busy) return { ...base, result: 'busy', digest: null };
  if (index < 0) return { ...base, result: 'none', digest: null };
  const tree = await git.tree();
  if (!tree) return { ...base, result: 'unavailable', digest: null };
  const sources = new Map(), files = new Set(), steps = [];
  let conflicts = [], stoppedAt = null;
  for (const point of points.slice(index).reverse()) {
    const changes = await git.changed(point.before, point.after);
    for (const change of changes) files.add(change.path);
    if (files.size > 10000) throw Error('checkpoint-preview-file-limit');
    const groups = new Map();
    for (const { path } of changes) {
      const source = sources.get(path) ?? tree;
      if (!groups.has(source)) groups.set(source, new Set());
      groups.get(source).add(path);
    }
    // A path already back as it was before this turn (an undo that stopped
    // midway) needs nothing and conflicts with nothing.
    const back = new Set(), edited = memberEdits(point.at);
    for (const [source, paths] of groups) {
      const differs = new Set((await git.changed(point.before, source)).map(change => change.path));
      for (const path of paths) if (!differs.has(path)) back.add(path);
      const drift = await git.changed(point.after, source);
      conflicts.push(...drift.filter(change => paths.has(change.path) && differs.has(change.path)).map(change => change.path));
    }
    conflicts.push(...changes.filter(change => edited.has(change.path) && !back.has(change.path)).map(change => change.path));
    if (conflicts.length) { stoppedAt = point.id; break; }
    const pending = changes.filter(change => !back.has(change.path));
    steps.push({ id: point.id, turnRef: point.turnRef, restore: pending.filter(change => change.status !== 'A').map(change => change.path),
      remove: pending.filter(change => change.status === 'A').map(change => change.path) });
    for (const { path } of changes) sources.set(path, point.before);
  }
  const preview = { ...base, tree, steps, files: [...files].sort(), conflicts: [...new Set(conflicts)].sort(), stoppedAt,
    result: conflicts.length ? 'conflict' : 'ready' };
  return { ...preview, digest: checkpointDigest(preview) };
}
