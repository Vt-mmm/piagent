import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Built-in grep/find for machines without ripgrep/fd (and where they could not
// be downloaded). Runs inside the sandbox worker. Files come from git (so
// .gitignore applies) or a bounded walk; unreadable files, such as credential
// files the sandbox denies, are skipped. Output mirrors Pi's grep/find.
const SKIP = new Set(['.git', 'node_modules', '.hg', '.svn']);
const MAX_FILES = 20_000, MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_LINE = 500, MAX_OUTPUT = 50 * 1024;

export function globToRegExp(glob) {
  let out = '', index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') { out += glob[index + 2] === '/' ? '(?:.*/)?' : '.*'; index += glob[index + 2] === '/' ? 3 : 2; continue; }
    if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '{') { const end = glob.indexOf('}', index); if (end > index) { out += '(?:' + glob.slice(index + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; index = end + 1; continue; } out += '\\{'; }
    else out += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp('^' + out + '$');
}
const matcher = glob => {
  if (!glob) return () => true;
  const regex = globToRegExp(glob.replace(/^\.\//, ''));
  return glob.includes('/') ? file => regex.test(file) : file => regex.test(file) || regex.test(path.basename(file));
};

function listFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean).slice(0, MAX_FILES);
  } catch { /* not a repository: walk */ }
  const files = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) walk(rel); }
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk('');
  return files;
}

function scope(cwd, target = '.') {
  const absolute = path.resolve(cwd, target);
  if (fs.statSync(absolute).isFile()) return { root: path.dirname(absolute), only: path.basename(absolute), base: absolute };
  return { root: absolute, only: null, base: absolute };
}

export function fallbackGrep(cwd, { pattern, path: target, glob, ignoreCase, literal, context = 0, limit = 100 }) {
  const { root, only } = scope(cwd, target);
  const source = literal ? String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(pattern);
  const regex = new RegExp(source, ignoreCase ? 'i' : '');
  const accept = matcher(glob), cap = Math.max(1, Math.min(1000, Number(limit) || 100)), around = Math.max(0, Math.min(10, Number(context) || 0));
  const lines = []; let matches = 0, bytes = 0;
  for (const rel of only ? [only] : listFiles(root)) {
    if (matches >= cap || bytes > MAX_OUTPUT) break;
    if (!accept(rel)) continue;
    const file = path.join(root, rel), shown = path.relative(cwd, file) || rel;
    let text;
    try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const rows = text.split(/\r?\n/);
    for (let index = 0; index < rows.length && matches < cap; index += 1) {
      if (!regex.test(rows[index])) continue;
      matches += 1;
      for (let at = Math.max(0, index - around); at <= Math.min(rows.length - 1, index + around); at += 1) {
        const line = `${shown}${at === index ? ':' : '-'}${at + 1}${at === index ? ':' : '-'} ${rows[at].slice(0, MAX_LINE)}`;
        lines.push(line); bytes += line.length;
      }
    }
  }
  const notice = matches >= cap ? `\n\n[${cap} matches limit reached. Use limit=${cap * 2} for more, or refine pattern]` : '';
  return { content: [{ type: 'text', text: matches ? lines.join('\n') + notice : 'No matches found' }], details: matches >= cap ? { matchLimitReached: cap } : undefined };
}

export function fallbackFind(cwd, { pattern, path: target, limit = 1000 }) {
  const { root } = scope(cwd, target);
  const accept = matcher(String(pattern)), cap = Math.max(1, Math.min(5000, Number(limit) || 1000));
  const found = [];
  for (const rel of listFiles(root)) {
    if (found.length >= cap) break;
    if (accept(rel)) found.push(path.relative(cwd, path.join(root, rel)) || rel);
  }
  return { content: [{ type: 'text', text: found.length ? found.join('\n') : 'No files found matching pattern' }], details: undefined };
}
