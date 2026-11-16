// Which changed files a command of this conversation owns (owner, 2026-11-16).
// The files a command changed are read by comparing the folder before and
// after it. In a folder of several repositories (Deploy: clones side by side)
// another conversation can be working at the same time: a 40-second test run
// here took in the screenshots a guide session was regenerating in another
// repository, the review of this conversation then went stale four times in a
// row and its final check never matched "the final code". So in such a folder
// a command owns only the files of the repositories it names (cd, -C, a path)
// and of those this conversation already works in; a command that names none,
// before anything is owned, keeps the old rule (everything it saw change).
import fs from 'node:fs';
import path from 'node:path';

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

// The changed files a command owns: all of them in one repository; in a
// folder of several, those in the repositories it names or already owns.
export function ownedChanges(cwd, command, changed, owned) {
  if (fs.existsSync(path.join(cwd, '.git'))) return changed;
  const named = commandRepositories(cwd, command), mine = new Set([...owned].map(file => repositoryOf(cwd, file)).filter(Boolean));
  if (!named.size && !mine.size) return changed;
  const allowed = new Set([...named, ...mine]);
  return changed.filter(file => allowed.has(repositoryOf(cwd, file)));
}
