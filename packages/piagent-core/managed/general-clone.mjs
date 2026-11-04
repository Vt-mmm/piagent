import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cacheDirectory } from './language-environment.mjs';

// The general helper changes files, so it never works in the member's
// project. It works in its own clone: a separate repository with its own
// .git (refs, config, hooks), no remote, and no writable path to the project
// or its refs. A linked worktree would share the project's .git, and the
// sandbox opens a shared git directory for writing. The clone is `--shared`: it
// borrows the project's object files (read-only inside the sandbox, by the
// boundary's readRoots) instead of copying them, so it costs about what a
// worktree costs. The only crossing is takeBack below, run by this runtime,
// not by the helper: it copies the clone's commits into the project as one
// private ref, refs/general/<id>, and touches nothing else. The main agent
// merges that ref itself.
export const GENERAL_ENTRY = 'agent-watch-general';
const OWNER = '.piagent-owner';
const run = promisify(execFile);
// The clone's own configuration is the helper's to write. The runtime
// therefore reads it only through git commands that cannot start a program
// the clone names: these override what a clone's config could set.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.alternateRefsCommand=', '-c', 'protocol.file.allow=always'];
const gitEnv = () => ({ PATH: '/usr/bin:/bin', HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8' });
const git = (exe, cwd, args) => run(exe, [...SAFE, ...args], { cwd, env: gitEnv(), maxBuffer: 4 << 20, timeout: 120_000 }).then(r => r.stdout.trim());

// A clone of the project's HEAD. Work not yet committed in the project is not
// in it: `dirty` lists those paths so the main agent can be told.
export async function cloneProject(managed) {
  // The clone's isolation is proven under the macOS sandbox only; the Linux (bubblewrap) path is not, so it stays closed.
  if (process.platform !== 'darwin') throw Error('managed-general-unavailable: the general helper is not verified on this platform yet; do the work yourself.');
  const exe = managed.boundary.git, project = managed.cwd;
  let top, base, dirty, objects;
  try {
    top = fs.realpathSync(await git(exe, project, ['rev-parse', '--show-toplevel']));
    base = await git(exe, project, ['rev-parse', '--verify', 'HEAD']);
    objects = fs.realpathSync(path.resolve(project, await git(exe, project, ['rev-parse', '--git-path', 'objects'])));
    dirty = (await git(exe, project, ['status', '--porcelain', '-uall'])).split('\n').filter(Boolean).map(l => l.replace(/^\S{1,2}\s+/, '')).slice(0, 50);
  } catch { throw Error('managed-general-needs-git: the general helper needs the project to be a git repository with a commit; commit first or do the work yourself.'); }
  if (top !== project) throw Error('managed-general-needs-git: the general helper needs the project folder to be the repository root.');
  const id = randomUUID().slice(0, 8), dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'piagent-general-'));
  try {
    await git(exe, dir, ['clone', '-q', '--shared', '--no-tags', '--template=', '--', project, path.join(dir, 'work')]);
    await git(exe, path.join(dir, 'work'), ['remote', 'remove', 'origin']);
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw Error(`managed-general-clone-failed: ${String(error?.message).slice(0, 200)}`); }
  const token = randomUUID(); // the proof, in the folder and in the session's record, that this runtime made it
  fs.writeFileSync(path.join(dir, OWNER), token, { mode: 0o600 });
  const real = fs.realpathSync(path.join(dir, 'work'));
  return { id, base, dirty, token, objects, cache: cacheDirectory(managed.boundary.userHome, real), root: dir, dir: real };
}

// The clone's folder, and the package cache the sandbox keyed to it (no later run shares it).
export function discardClone(clone) { fs.rmSync(clone.root, { recursive: true, force: true }); fs.rmSync(clone.cache, { recursive: true, force: true }); }

// Bring the clone's commits into the project as refs/general/<id> and
// discard the clone. Returns what the main agent needs to merge them.
export async function takeBack(managed, clone) {
  const exe = managed.boundary.git, project = managed.cwd;
  try {
    // The helper writes the clone's .git: a gitfile or alternates would point
    // the fetch at a path outside it.
    const dotgit = path.join(clone.dir, '.git');
    const alternates = path.join(dotgit, 'objects/info/alternates');
    if (!fs.lstatSync(dotgit).isDirectory() || fs.readFileSync(alternates, 'utf8').trim() !== clone.objects) throw Error('the clone was changed to point outside itself');
    const ref = `refs/general/${clone.id}`;
    await git(exe, project, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', clone.dir, `+HEAD:${ref}`]);
    const head = await git(exe, project, ['rev-parse', '--verify', ref]);
    if (head === clone.base) { await git(exe, project, ['update-ref', '-d', ref]); return { ref: null, head, base: clone.base, files: [], note: 'The general helper made no commit, so nothing came back. Only committed work is returned.' }; }
    if (!(await git(exe, project, ['merge-base', '--is-ancestor', clone.base, head]).then(() => true, () => false))) { await git(exe, project, ['update-ref', '-d', ref]); throw Error('the clone no longer descends from the commit it started from'); }
    const files = (await git(exe, project, ['diff', '--numstat', `${clone.base}..${head}`])).split('\n').filter(Boolean).map(l => { const [added, deleted, ...name] = l.split('\t'); return `+${added} -${deleted} ${name.join('\t')}`; }).slice(0, 80);
    return { ref, head, base: clone.base, files, note: null };
  } finally { discardClone(clone); }
}

// What the main agent reads with the helper's answer.
export function takeBackText(clone, back) {
  const dirty = clone.dirty.length ? ` The helper did not see ${clone.dirty.length} uncommitted path(s) in the project (${clone.dirty.slice(0, 8).join(', ')}${clone.dirty.length > 8 ? ', …' : ''}).` : '';
  if (!back.ref) return `\n\n${back.note}${dirty}`;
  return `\n\nThe general helper's commits are in ${back.ref} (${back.base.slice(0, 9)}..${back.head.slice(0, 9)}); your files are unchanged. Merge or cherry-pick that ref yourself, run the checks on the result, then ask for review; delete the ref afterwards (git update-ref -d ${back.ref}). Changed:\n${back.files.join('\n')}${dirty}`;
}

// One entry per general run, so a later turn knows what ran and what came back;
// "running" with the folder and its token is also the record of what to recover.
export function recordGeneral(managed, clone, status, back = null) {
  managed.session.sessionManager.appendCustomEntry(GENERAL_ENTRY, { id: clone.id, base: clone.base, status, root: clone.root, token: clone.token, ...(back?.ref ? { ref: back.ref, head: back.head } : {}), at: new Date().toISOString() });
}
// A crash or a kill skips the cleanup above. When the conversation next runs a
// general helper, a run its record still calls "running" (and this process
// is not running) has its clone removed only if the folder is provably the one
// this runtime made: a real folder, ours, directly in the temporary folder,
// holding the token the record names. Anything else is only reported.
export function sweepGeneral(managed) {
  const last = new Map(), tmp = fs.realpathSync(os.tmpdir()), removed = [], unproven = [];
  for (const e of managed.session.sessionManager.getEntries?.() ?? []) if (e.type === 'custom' && e.customType === GENERAL_ENTRY) last.set(e.data.id, e.data);
  for (const d of last.values()) {
    if (d.status !== 'running' || typeof d.root !== 'string' || managed.liveClones?.has(d.root)) continue;
    let st; try { st = fs.lstatSync(d.root); } catch { continue; } // already gone
    let owned = false;
    try {
      owned = st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && path.dirname(d.root) === tmp && path.basename(d.root).startsWith('piagent-general-')
        && fs.readFileSync(path.join(d.root, OWNER), 'utf8') === d.token;
    } catch { /* no marker: not proven */ }
    if (owned) { fs.rmSync(d.root, { recursive: true, force: true }); removed.push(d.id); } else unproven.push(d.root);
  }
  return { removed, unproven };
}
export const sweepText = ({ removed, unproven }) => (removed.length ? `\n\nAn earlier general run (${removed.join(', ')}) was interrupted; its clone folder was removed and any work in it was not returned.` : '')
  + (unproven.length ? `\n\nA folder an earlier general run recorded could not be proven to be the one it made, so it was left in place: ${unproven.join(', ')}.` : '');
