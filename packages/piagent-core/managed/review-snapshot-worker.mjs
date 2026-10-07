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
const git = args => execFileSync(managedGit(), ['--no-pager', ...args], { encoding: 'utf8', maxBuffer: MAX_SNAPSHOT + 1, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
const sha256 = data => createHash('sha256').update(data).digest('hex');
const mode = process.argv[2];
// "files": what each changed or new file holds now (a hash, "deleted"), so
// the runtime can tell which files one conversation's command changed.
if (mode === 'files') {
  const changed = git(['diff', '--name-only', '--no-renames', '--relative', '-z', 'HEAD', '--', '.']).split('\0').filter(Boolean);
  const fresh = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (changed.length + fresh.length > MAX_UNTRACKED * 4) throw Error('review-untracked-limit');
  const print = name => {
    let stat; try { stat = fs.lstatSync(name); } catch { return 'deleted'; }
    if (stat.isSymbolicLink()) return 'link:' + sha256(fs.readlinkSync(name));
    if (stat.isDirectory()) return 'dir:' + sha256(fs.readdirSync(name).sort().join('\0'));
    return stat.size > HASHED_FILE ? `size:${stat.size}:${stat.mtimeMs}` : sha256(fs.readFileSync(name)) + ':' + (stat.mode & 0o777);
  };
  const files = Object.fromEntries([...new Set([...changed, ...fresh])].sort().map(name => [name, print(name)]));
  const name = `files-${randomUUID()}.json`, data = Buffer.from(JSON.stringify(files));
  fs.writeFileSync(path.join(os.tmpdir(), name), data, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${sha256(data)} ${data.length} ${name}`);
  process.exit(0);
}
// A scope (a file the runtime wrote in this boundary's temporary directory):
// only these paths, the ones this conversation changed, make the patch.
const scopeName = process.argv[3];
if (scopeName !== undefined && !/^scope-[0-9a-f-]{36}\.json$/.test(scopeName)) throw Error('review-scope-invalid');
const scope = scopeName ? new Set(JSON.parse(fs.readFileSync(path.join(os.tmpdir(), scopeName), 'utf8'))) : null;
if (scope && [...scope].some(p => typeof p !== 'string' || !p || path.isAbsolute(p) || p.split('/').includes('..'))) throw Error('review-scope-invalid');
const patch = scope && !scope.size ? '' : git(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', ...(scope ? [...scope].sort().map(p => ':(literal)' + p) : ['.'])]);
const paths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).filter(p => !scope || scope.has(p)).sort();
if (paths.length > MAX_UNTRACKED) throw Error('review-untracked-limit');
const untracked = paths.map(name => {
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
});
const snapshot = Buffer.from(JSON.stringify({ patch, untracked }));
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
