import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { managedGit } from './toolchain.mjs';
// Executed only through the tool Seatbelt boundary; repo-local Git config cannot
// grant a hook, textconv or credential helper access to the trusted runtime.
const git = args => execFileSync(managedGit(), ['--no-pager', ...args], { encoding: 'utf8', maxBuffer: 160000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
const patch = git(['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']);
const paths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
if (paths.length > 100) throw Error('review-untracked-limit');
const untracked = paths.map(name => {
  const stat = fs.lstatSync(name);
  if (stat.isSymbolicLink()) return { path: name, mode: 'symlink', target: fs.readlinkSync(name) };
  if (!stat.isFile() || stat.size > 120000) throw Error('review-file-limit');
  // Text goes as text, so the reviewer can read new files; binary as base64.
  const data = fs.readFileSync(name);
  let text = null;
  if (!data.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { text = null; } }
  return text === null ? { path: name, mode: stat.mode & 0o777, contents: data.toString('base64'), encoding: 'base64' } : { path: name, mode: stat.mode & 0o777, contents: text, encoding: 'utf8' };
});
const snapshot = JSON.stringify({ patch, untracked });
if (Buffer.byteLength(snapshot) > 120000) throw Error('review-patch-limit');
// With a part number the snapshot is sent in base64 parts small enough for the
// shell tool's output limit, each headed by the whole snapshot's digest.
const part = process.argv[2], bytes = Buffer.from(snapshot), SIZE = 30000;
if (part === undefined) process.stdout.write(snapshot);
else process.stdout.write(`${createHash('sha256').update(bytes).digest('hex')} ${Math.max(1, Math.ceil(bytes.length / SIZE))}\n${bytes.subarray(Number(part) * SIZE, (Number(part) + 1) * SIZE).toString('base64')}`);
