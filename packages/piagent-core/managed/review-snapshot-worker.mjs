import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { managedGit } from './toolchain.mjs';
// Executed only through the tool Seatbelt boundary; repo-local Git config cannot
// grant a hook, textconv or credential helper access to the trusted runtime.
// The snapshot holds the whole patch (its digest decides whether a review is
// stale); a reviewer reads it in parts (patch-snapshot.mjs). A new file too
// large to read is held by its hash: a change to it still changes the digest.
const MAX_SNAPSHOT = 16 * 1024 * 1024, MAX_UNTRACKED = 2000, READ_FILE = 400_000, BINARY_INLINE = 120_000, HASHED_FILE = 256 * 1024 * 1024;
// Git speaks English here (LC_ALL=C), so the runtime can tell why a snapshot
// failed (reviewUnavailableReason), and its errors come back as one line, not
// a usage page or a stack.
const git = args => execFileSync(managedGit(), ['--no-pager', ...args], { encoding: 'utf8', maxBuffer: MAX_SNAPSHOT + 1, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } });
process.on('uncaughtException', error => {
  const detail = String(error?.stderr ?? '').trim().split('\n').find(Boolean);
  process.stderr.write(`${String(error?.message ?? error).split('\n')[0]}${detail ? `: ${detail}` : ''}\n`);
  process.exit(1);
});
const sha256 = data => createHash('sha256').update(data).digest('hex');
const insideWorkTree = () => { try { return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } };
// The repository (relative to the folder) that holds a path: the nearest
// folder below the folder, above the path, with a .git entry; or null.
function repositoryOf(file) {
  for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) if (fs.existsSync(path.join(dir, '.git'))) return dir;
  return null;
}
// The repositories below a folder that is none itself (clones side by side),
// relative to the folder. A repository's own folders are not searched.
const SEARCH_DEPTH = 3, MAX_REPOSITORIES = 64, NOT_SEARCHED = new Set(['node_modules', 'vendor', 'dist', 'build', 'target']);
function childRepositories() {
  const found = [];
  const search = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir || '.', { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || NOT_SEARCHED.has(entry.name) || found.length >= MAX_REPOSITORIES) continue;
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (fs.existsSync(path.join(child, '.git'))) found.push(child);
      else if (depth < SEARCH_DEPTH) search(child, depth + 1);
    }
  };
  search('', 1);
  return found;
}
const repoGit = (repository, args) => git(['-C', repository, ...args]);
const repoHead = repository => { try { return repoGit(repository, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim(); } catch { return ''; } };
const mode = process.argv[2];
// The arguments after the mode: a scope file, then the commit the patch starts
// from (the turn's starting HEAD; commits made since are part of the change).
// While HEAD has not moved, the patch is the plain one against HEAD.
const head = () => { try { return git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim(); } catch { return ''; } };
if (mode === 'head') { process.stdout.write(head() || 'none'); process.exit(0); }
// "heads": where each repository below the folder stands, so a commit made
// during the turn stays part of its change, as `base` does in one repository.
if (mode === 'heads') {
  const heads = insideWorkTree() ? {} : Object.fromEntries(childRepositories().map(r => [r, repoHead(r)]).filter(([, sha]) => sha));
  const name = `heads-${randomUUID()}.json`, data = Buffer.from(JSON.stringify(heads));
  fs.writeFileSync(path.join(os.tmpdir(), name), data, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${sha256(data)} ${data.length} ${name}`);
  process.exit(0);
}
// "since <ref>": the commit a reference names, when HEAD descends from it (a
// review of the commits made since); "branch-base": where this branch left
// the default branch (or, on it, its upstream), when commits came since.
const commit = ref => { try { return git(['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]).trim(); } catch { return ''; } };
const ancestor = sha => { try { git(['merge-base', '--is-ancestor', sha, 'HEAD']); return true; } catch { return false; } };
if (mode === 'since') {
  const ref = process.argv[3] ?? '', sha = /^[A-Za-z0-9._\/~^@{}-]{1,200}$/.test(ref) && !ref.startsWith('-') ? commit(ref) : '';
  process.stdout.write(sha && ancestor(sha) ? sha : 'none'); process.exit(0);
}
if (mode === 'branch-base') {
  const now = head();
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master', '@{upstream}']) {
    const tip = commit(ref); if (!tip || !now) continue;
    let base = ''; try { base = git(['merge-base', 'HEAD', tip]).trim(); } catch { continue; }
    if (base && base !== now) { process.stdout.write(`${base} ${ref}`); process.exit(0); }
  }
  process.stdout.write('none'); process.exit(0);
}
const extra = process.argv.slice(3), given = extra.find(a => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(a));
const base = given && given !== head() ? given : 'HEAD';
// `bases-….json` (from "heads"): the commit each repository below the folder
// started the turn on; a repository not named is compared with its HEAD.
const basesName = extra.find(a => a.startsWith('bases-'));
if (basesName !== undefined && !/^bases-[0-9a-f-]{36}\.json$/.test(basesName)) throw Error('review-scope-invalid');
const bases = basesName ? JSON.parse(fs.readFileSync(path.join(os.tmpdir(), basesName), 'utf8')) : {};
const baseOf = repository => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(bases[repository] ?? '') ? bases[repository] : 'HEAD';
// "files": what each changed or new file holds now (a hash, "deleted"), so
// the runtime can tell which files one conversation's command changed.
if (mode === 'files') {
  // In a folder of several repositories each one answers for its own files,
  // named from the folder. Without this a command's changes there have no
  // owner and a review of them cannot run (seen 2026-10-30: `not_git`).
  const repositories = insideWorkTree() ? [] : childRepositories();
  const listed = (run, from, prefix) => [...run(['diff', '--name-only', '--no-renames', '--relative', '-z', from, '--', '.']).split('\0'), ...run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean).map(name => prefix + name);
  const all = repositories.length ? repositories.flatMap(r => { try { return listed(args => repoGit(r, args), baseOf(r), `${r}/`); } catch { return []; } }) : listed(git, base, '');
  if (all.length > MAX_UNTRACKED * 4) throw Error('review-untracked-limit');
  const print = name => {
    let stat; try { stat = fs.lstatSync(name); } catch { return 'deleted'; }
    if (stat.isSymbolicLink()) return 'link:' + sha256(fs.readlinkSync(name));
    if (stat.isDirectory()) return 'dir:' + sha256(fs.readdirSync(name).sort().join('\0'));
    return stat.size > HASHED_FILE ? `size:${stat.size}:${stat.mtimeMs}` : sha256(fs.readFileSync(name)) + ':' + (stat.mode & 0o777);
  };
  const files = Object.fromEntries([...new Set(all)].sort().map(name => [name, print(name)]));
  const name = `files-${randomUUID()}.json`, data = Buffer.from(JSON.stringify(files));
  fs.writeFileSync(path.join(os.tmpdir(), name), data, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${sha256(data)} ${data.length} ${name}`);
  process.exit(0);
}
// A scope (a file the runtime wrote in this boundary's temporary directory):
// only these paths, the ones this conversation changed, make the patch.
const scopeName = extra.find(a => a !== given && a !== basesName);
if (scopeName !== undefined && !/^scope-[0-9a-f-]{36}\.json$/.test(scopeName)) throw Error('review-scope-invalid');
const scope = scopeName ? new Set(JSON.parse(fs.readFileSync(path.join(os.tmpdir(), scopeName), 'utf8'))) : null;
if (scope && [...scope].some(p => typeof p !== 'string' || !p || path.isAbsolute(p) || p.split('/').includes('..'))) throw Error('review-scope-invalid');
// A folder that is not a repository but holds several (clones side by side):
// each changed path is diffed in the repository that holds it, against that
// repository's HEAD, with its paths kept relative to the folder. A path no
// repository holds is named, not read. With no scope, every repository's
// changes make the patch; a conversation with no change yet has an empty one.
const repositories = [], outside = [];
let patch = '', paths;
const several = insideWorkTree() ? [] : childRepositories();
if (scope && !scope.size && several.length) paths = [];
else if ((scope ? scope.size : several.length) && !insideWorkTree()) {
  const groups = new Map();
  if (!scope) for (const repository of several) groups.set(repository, ['.']);
  for (const file of [...(scope ?? [])].sort()) {
    const repository = repositoryOf(file);
    if (repository === null) { outside.push(file); continue; }
    if (!groups.has(repository)) groups.set(repository, []);
    groups.get(repository).push(file.slice(repository.length + 1));
  }
  if (!groups.size) throw Error('managed-review-patch-unreadable: not a git repository');
  paths = [];
  for (const [repository, files] of groups) {
    const spec = files.map(p => p === '.' ? '.' : ':(literal)' + p), run = args => repoGit(repository, args);
    repositories.push(repository);
    patch += run(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', `--src-prefix=a/${repository}/`, `--dst-prefix=b/${repository}/`, baseOf(repository), '--', ...spec]);
    paths.push(...run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...spec]).split('\0').filter(Boolean).map(p => `${repository}/${p}`));
  }
  paths.sort();
} else {
  patch = scope && !scope.size ? '' : git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', ...(scope ? [...scope].sort().map(p => ':(literal)' + p) : ['.'])]);
  paths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).filter(p => !scope || scope.has(p)).sort();
}
if (paths.length + outside.length > MAX_UNTRACKED) throw Error('review-untracked-limit');
const untracked = [...paths.map(read), ...outside.map(name => {
  let stat; try { stat = fs.lstatSync(name); } catch { return { path: name, mode: 'outside', encoding: 'omitted', bytes: 0, sha256: 'deleted' }; }
  const data = stat.isFile() && stat.size <= HASHED_FILE ? fs.readFileSync(name) : Buffer.from(`${stat.size}:${stat.mtimeMs}`);
  return { path: name, mode: 'outside', encoding: 'omitted', bytes: stat.size, sha256: sha256(data) };
})];
function read(name) {
  const stat = fs.lstatSync(name);
  if (stat.isSymbolicLink()) return { path: name, mode: 'symlink', target: fs.readlinkSync(name) };
  // A folder Git lists as one entry is a repository of its own (a clone
  // inside the project): named, not read, and its entries keep the digest.
  if (stat.isDirectory()) return { path: name, mode: 'directory', encoding: 'omitted', bytes: 0, sha256: sha256(fs.readdirSync(name).sort().join('\0')) };
  if (!stat.isFile() || stat.size > HASHED_FILE) throw Error('review-file-limit');
  const data = fs.readFileSync(name), mode = stat.mode & 0o777;
  if (stat.size > READ_FILE) return { path: name, mode, encoding: 'omitted', bytes: stat.size, sha256: sha256(data) };
  // Text goes as text, so the reviewer can read new files; binary as base64.
  let text = null;
  if (!data.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { text = null; } }
  if (text !== null) return { path: name, mode, contents: text, encoding: 'utf8' };
  return stat.size > BINARY_INLINE ? { path: name, mode, encoding: 'omitted', bytes: stat.size, sha256: sha256(data) } : { path: name, mode, contents: data.toString('base64'), encoding: 'base64' };
}
const snapshot = Buffer.from(JSON.stringify(repositories.length ? { repositories, patch, untracked } : base === 'HEAD' ? { patch, untracked } : { base, patch, untracked }));
if (snapshot.length > MAX_SNAPSHOT) throw Error('review-patch-limit');
// "digest": the digest and size only (is a review still current?). "file":
// the snapshot goes to a new file in this boundary's temporary directory,
// named on stdout with its digest; the runtime reads it once, checks the
// digest and removes it. No argument: the snapshot itself.
if (mode === 'digest') process.stdout.write(`${sha256(snapshot)} ${snapshot.length}`);
else if (mode === 'file') {
  const name = `review-${randomUUID()}.json`;
  fs.writeFileSync(path.join(os.tmpdir(), name), snapshot, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${sha256(snapshot)} ${snapshot.length} ${name}`);
} else process.stdout.write(snapshot);
