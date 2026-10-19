// Which repositories team memory uses in a conversation's folder and what
// git says about them: the folder's own repository or the ones one level down,
// remotes other than origin, checkouts git calls of "dubious ownership", and
// the files each commit touched. Memory only reads git.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

// A folder that holds several repositories (front end, back end…) gets the
// memory of each, at most MAX_REPOS.
const MAX_REPOS = 6;

// The repository's identity: its origin remote without scheme, user, port
// or ".git", lower case ("github.com/acme/shop"). null: no memory here.
export function repoKey(remote) {
  let s = String(remote ?? '').trim();
  if (!s) return null;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s); // git@github.com:acme/shop.git
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try { const u = new URL(s); if (!['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) return null; s = `${u.hostname}${u.pathname}`; }
    catch { return null; }
  }
  s = s.toLowerCase().replace(/\.git\/?$/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._/-]+$/.test(s) && s.length <= 200 && !s.includes('..') ? s : null;
}

// Memory only reads (remote, branch, log, status). A repository another user
// owns (a Windows drive seen from WSL, a shared checkout) makes git refuse
// with "dubious ownership"; the read is retried trusting that one folder.
const gitOnce = (cwd, args, timeout, signal) => new Promise(resolve => execFile('git', ['-C', cwd, ...args], { timeout, signal, maxBuffer: 4 << 20, encoding: 'utf8' },
  (error, stdout, stderr) => resolve(error ? { out: null, err: String(stderr ?? '') } : { out: stdout })));
export const git = async (cwd, args, timeout = 3_000, signal) => {
  const first = await gitOnce(cwd, args, timeout, signal);
  if (first.out !== null || !/dubious ownership/i.test(first.err)) return first.out;
  return (await gitOnce(cwd, ['-c', `safe.directory=${cwd}`, ...args], timeout, signal)).out
    ?? (await gitOnce(cwd, ['-c', 'safe.directory=*', ...args], timeout, signal)).out;
};

// The repository at dir: its key, its top folder and the name the folder
// gives it. reason says why there is none: not_a_repository, no_origin
// (no remote at all) or unsupported_remote (a remote repoKey cannot read).
export async function repositoryAt(dir, name = '', signal) {
  const top = (await git(dir, ['rev-parse', '--show-toplevel'], 3_000, signal))?.trim();
  if (!top) return { reason: 'not_a_repository' };
  let remote = (await git(dir, ['remote', 'get-url', 'origin'], 3_000, signal))?.trim();
  if (!remote) {
    // No origin: a repository with exactly one remote is known by it.
    const remotes = (await git(dir, ['remote'], 3_000, signal))?.split('\n').map(r => r.trim()).filter(Boolean) ?? [];
    if (remotes.length !== 1) return { reason: 'no_origin' };
    remote = (await git(dir, ['remote', 'get-url', remotes[0]], 3_000, signal))?.trim();
  }
  const key = repoKey(remote);
  return key ? { key, dir: top, name } : { reason: 'unsupported_remote' };
}

// The repositories memory can use in cwd: the folder's own, or else the
// ones one level down. folder is the reason when there is none.
export async function findRepositories(cwd, signal) {
  const own = await repositoryAt(cwd, '', signal);
  if (own.key) return { repos: [own], folder: null };
  if (own.reason !== 'not_a_repository') return { repos: [], folder: own.reason };
  let names = [];
  try {
    names = fs.readdirSync(cwd, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name).filter(n => fs.existsSync(path.join(cwd, n, '.git'))).sort().slice(0, 40);
  } catch { /* unreadable folder */ }
  const repos = [], seen = new Set();
  let reason = 'not_a_repository';
  for (const name of names) {
    if (repos.length >= MAX_REPOS) break;
    const r = await repositoryAt(path.join(cwd, name), name, signal);
    if (r.key && !seen.has(r.key)) { seen.add(r.key); repos.push(r); } else if (r.reason && r.reason !== 'not_a_repository') reason = r.reason;
  }
  return { repos, folder: repos.length ? null : reason };
}

// Top-level folders of a set of repository-relative paths.
export const topDirs = (files, max = 8) => [...new Set(files.map(f => String(f).split('/')).filter(p => p.length > 1 && p[0] && !p[0].startsWith('.')).map(p => p[0]))].slice(0, max);
// A stable event per extra repository of one round, so a retry is a duplicate.
export const eventFor = (id, key, i) => {
  if (!i) return id;
  const h = createHash('sha256').update(`${id}\0${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// Changes a commit made that leave memories about a file stale.
export function commitChanges(lines) {
  const changes = [], files = [];
  const unbrace = s => { const m = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s); return m ? [`${m[1]}${m[2]}${m[4]}`.replace(/\/\//g, '/'), `${m[1]}${m[3]}${m[4]}`.replace(/\/\//g, '/')] : s.split(' => '); };
  for (const line of lines) {
    let m;
    if ((m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line))) {
      const [from, to = from] = unbrace(m[3]); files.push(to);
      const added = Number(m[1]), deleted = Number(m[2]);
      if (deleted >= 30 && deleted >= added * 0.7 && from === to) changes.push({ path: to, kind: 'rewritten' });
    } else if ((m = /^ delete mode \d+ (.+)$/.exec(line))) changes.push({ path: m[1], kind: 'deleted' });
    else if ((m = /^ rename (.+) \(\d+%\)$/.exec(line))) changes.push({ path: unbrace(m[1])[0], kind: 'renamed' });
    else if ((m = /^ rewrite (.+) \(\d+%\)$/.exec(line))) changes.push({ path: m[1], kind: 'rewritten' });
  }
  const unique = new Map(changes.filter(c => c.path && c.path.length <= 300).map(c => [c.path, c]));
  return { dirs: topDirs(files), changes: [...unique.values()].slice(0, 20) };
}

