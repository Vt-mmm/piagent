import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

// Conversations nobody has touched for 30 days give up their checkpoints: the
// state file goes, and with it the refs that kept their trees alive, so the
// private store does not grow with every conversation ever held in a project.
// A session holding its lock, and the caller's own session, are left alone.
export function pruneStaleCheckpointSessions(directory, refs, keep, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(directory); } catch { return 0; }
  let pruned = 0;
  for (const name of names) {
    const key = /^([a-f0-9]{64})\.json$/.exec(name)?.[1];
    if (!key || key === keep || names.includes(`${key}.lock`)) continue;
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs < STALE_MS) continue;
      const prefix = `refs/piagent/checkpoints/${key}/`;
      const lines = refs.run(['for-each-ref', '--format=%(refname) %(objectname)', prefix]).trim().split('\n').filter(Boolean)
        .map(line => { const [ref, object] = line.split(' '); return `delete ${ref} ${object}`; });
      if (lines.length) refs.run(['update-ref', '--stdin'], Buffer.from(['start', ...lines, 'prepare', 'commit', ''].join('\n')));
      fs.unlinkSync(file); pruned++;
    } catch { /* another process is using it; try again next time */ }
  }
  return pruned;
}
