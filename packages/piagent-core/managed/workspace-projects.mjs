// The projects a company conversation works in, for Studio's project warnings
// (workspace-report.mjs, managed.workspace.v2). A folder with a readable
// remote is its repository (memory's repo key). A git checkout without one
// (no remote, several remotes but no origin, a remote repoKey cannot read)
// is local/git/<root commit>, the same on every computer holding that
// history; a checkout without commits and any other folder is
// local/dir/<hash of the computer's name and the path>, one computer only.
// Each comes with its folder's name; a path never leaves the computer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, repositoryAt } from './memory-repos.mjs';

// As memory: the folder's own project, or at most MAX_PROJECTS one level down.
const MAX_PROJECTS = 6;

// The oldest commit of the history; with several roots (merged histories)
// the smallest, so every computer picks the same one.
export async function rootCommit(dir, signal) {
  const out = await git(dir, ['rev-list', '--max-parents=0', 'HEAD'], 5_000, signal);
  return out?.split('\n').map(line => line.trim()).filter(line => /^[0-9a-f]{40}$/.test(line)).sort()[0] ?? null;
}

export function folderKey(dir, host = os.hostname()) {
  let real = path.resolve(dir);
  try { real = fs.realpathSync(dir); } catch { /* a folder that went away keeps its spelling */ }
  return `local/dir/${createHash('sha256').update(`piagent-local-dir\0${host}\0${real}`).digest('hex').slice(0, 24)}`;
}

// The folder's last name as Studio records it (internal/projects CleanName).
export const folderName = dir => path.basename(path.resolve(dir)).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, '').trim().slice(0, 80) || null;

// The project at dir, or null when dir is not inside a git checkout.
async function projectAt(dir, signal, host) {
  const repository = await repositoryAt(dir, '', signal);
  if (repository.key) return { key: repository.key, name: folderName(repository.dir) };
  if (repository.reason === 'not_a_repository') return null;
  const top = (await git(dir, ['rev-parse', '--show-toplevel'], 3_000, signal))?.trim() || dir;
  const root = await rootCommit(top, signal);
  return { key: root ? `local/git/${root}` : folderKey(top, host), name: folderName(top) };
}

// Every project in cwd: its own, or else the checkouts one level down, or
// else cwd itself as a local folder. Empty only when cwd cannot be read.
export async function findProjects(cwd, { signal, host } = {}) {
  const own = await projectAt(cwd, signal, host);
  if (own) return [own];
  let names;
  try {
    names = fs.readdirSync(cwd, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name).filter(n => fs.existsSync(path.join(cwd, n, '.git'))).sort().slice(0, 40);
  } catch { return []; }
  const projects = [], seen = new Set();
  for (const name of names) {
    if (projects.length >= MAX_PROJECTS) break;
    const project = await projectAt(path.join(cwd, name), signal, host);
    if (project && !seen.has(project.key)) { seen.add(project.key); projects.push(project); }
  }
  return projects.length ? projects : [{ key: folderKey(cwd, host), name: folderName(cwd) }];
}
