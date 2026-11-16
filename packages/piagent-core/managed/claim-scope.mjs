// Which changed files belong to this conversation (owner, 2026-11-16).
//
// The files a command changed are read by comparing the folder before and
// after it. In a folder of several repositories (Deploy: clones side by side)
// another conversation can be working at the same time: a 40-second test run
// here took in the screenshots a guide session was regenerating in another
// repository, the review went stale four times and read another session's
// work. Work also flows across repositories on purpose (a generator in the
// front end writes into the back end, a release script touches several), so
// a repository is never left out by name alone: only by what was seen.
//
// - The repositories this conversation works in: those it edits with
//   edit/write, and those its commands name (cd, -C, a path). Their changes
//   are always its own. The list is kept with the conversation across turns,
//   never read back from a list of files carried over from an earlier turn.
// - A repository that changed while no command of this conversation ran
//   (between two commands) is being changed by something else: another
//   conversation, a watcher, a generator. For FOREIGN_MS after that, its
//   changes during a command are not taken unless the conversation works in
//   it, and the member is told which files were left out.
// - Any other repository's changes during a command are this conversation's,
//   as before.
// One repository (the folder is a repository itself): every change is its own.
import fs from 'node:fs';
import path from 'node:path';

export const FOREIGN_MS = 30 * 60_000;
export const WORK_REPOS_ENTRY = 'agent-watch-work-repos';

// The repository (relative to the folder) that holds a relative path, or null.
export function repositoryOf(cwd, file) {
  for (let dir = path.posix.dirname(file); dir && dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir))
    if (fs.existsSync(path.join(cwd, dir, '.git'))) return dir;
  return null;
}

// The repositories a command names, relative to the folder.
export function commandRepositories(cwd, command) {
  const found = new Set();
  for (const raw of String(command ?? '').split(/[\s;&|()<>"'`=]+/)) {
    if (!raw || raw.startsWith('-') || /^[a-z]+:\/\//i.test(raw)) continue;
    const relative = path.relative(cwd, path.resolve(cwd, raw.replace(/^~(?=\/)/, process.env.HOME ?? '~')));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const name = relative.split(path.sep).join('/'), repository = fs.existsSync(path.join(cwd, name, '.git')) ? name : repositoryOf(cwd, `${name}/x`);
    if (repository) found.add(repository);
  }
  return found;
}

const differing = (a, b) => a && b ? [...new Set([...a.keys(), ...b.keys()])].filter(name => a.get(name) !== b.get(name)) : [];
const single = cwd => fs.existsSync(path.join(cwd, '.git'));

// The conversation's claim state: { work: Set of repositories, foreign: Map
// repository → when something else was seen changing it, last: the folder
// after the last command, edited: files edit/write changed since }.
export const claimState = (work = []) => ({ work: new Set(work), foreign: new Map(), last: null, edited: new Set(), left: new Map() });
// Files left out earlier in a repository the conversation now works in: its own after all.
const takeLeft = (state, repository) => { const files = state.left.get(repository) ?? []; state.left.delete(repository); return files; };

// edit/write changed `file` (relative): its repository is one the conversation works in.
export function claimEdit(cwd, state, file) {
  state.edited.add(file);
  const repository = single(cwd) ? null : repositoryOf(cwd, file);
  if (!repository) return [];
  state.work.add(repository);
  return takeLeft(state, repository);
}

// After a command: the files it changed that are this conversation's, and
// those left out ({ owned, skipped: Map repository → files }).
export function claimCommand(cwd, state, command, before, after, now = Date.now()) {
  const during = differing(before, after);
  if (single(cwd)) { state.last = after; state.edited.clear(); return { owned: during, skipped: new Map() }; }
  // Changes between the last command and this one that no edit/write of
  // this conversation made: something else is changing that repository.
  for (const file of differing(state.last, before)) {
    if (state.edited.has(file)) continue;
    const repository = repositoryOf(cwd, file);
    if (repository) state.foreign.set(repository, now);
  }
  const owned = [], skipped = new Map();
  for (const repository of commandRepositories(cwd, command)) { state.work.add(repository); owned.push(...takeLeft(state, repository)); }
  for (const file of during) {
    const repository = repositoryOf(cwd, file), seen = repository ? state.foreign.get(repository) : undefined;
    if (!repository || state.work.has(repository) || seen === undefined || now - seen > FOREIGN_MS) { owned.push(file); continue; }
    if (!skipped.has(repository)) skipped.set(repository, []);
    skipped.get(repository).push(file);
    state.left.set(repository, [...new Set([...(state.left.get(repository) ?? []), file])].slice(-2000));
  }
  state.last = after; state.edited.clear();
  return { owned, skipped };
}

// The repositories the conversation works in, kept with it across turns.
export function restoreWorkRepos(manager) {
  const last = manager?.getEntries?.().filter(e => e.type === 'custom' && e.customType === WORK_REPOS_ENTRY).at(-1)?.data;
  return Array.isArray(last?.repos) ? last.repos.filter(r => typeof r === 'string' && r).slice(0, 200) : [];
}
export function saveWorkRepos(manager, state, saved) {
  const repos = [...state.work].sort();
  if (repos.join('\n') === saved) return saved;
  try { manager.appendCustomEntry(WORK_REPOS_ENTRY, { repos, at: new Date().toISOString() }); } catch { /* kept in memory */ }
  return repos.join('\n');
}

// What the member reads when files were left out.
export function skippedText(skipped) {
  return [...skipped].map(([repository, files]) => `Không nhận ${files.length} file đã đổi ở ${repository} là việc của cuộc trò chuyện này: repo này vừa bị tiến trình khác sửa (phiên khác trong cùng folder, watcher hay script sinh file), và cuộc trò chuyện này chưa làm việc trong đó. Nếu đúng là việc của mình, hãy cd vào repo đó hoặc sửa file trong đó, harness sẽ nhận. File: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` và ${files.length - 5} file khác` : ''}.`).join('\n');
}
