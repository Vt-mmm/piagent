import fs from 'node:fs';
import path from 'node:path';

// The company sandbox on Linux, and so on Windows through WSL2: what Seatbelt
// does on macOS (tool-boundary.mjs), built from bubblewrap mounts. Nothing is
// there unless mounted:
// - system folders, toolchains, the SDK and skill folders read-only;
// - the project (read-only for helpers), its package cache and a private
//   temporary folder writable;
// - the member's own folders read-only for reference, without the home
//   folder's hidden entries (shell files, histories, tool settings, keys);
// - credential files found in what is mounted read as empty (an empty file
//   mounted over them: /dev/null cannot be opened in a user namespace);
// - everything else, the root included, read-only: a write elsewhere fails
//   as it does on macOS instead of landing in a throwaway folder.
// A command without approval runs in its own network namespace: it reaches
// the servers it starts itself, nothing else (no internet, no proxy, no
// service of this machine). Its processes end with it. Windows programs
// cannot be started from inside: WSL's interop socket is not mounted.
export const BWRAP = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;

const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt', '/snap', '/sys', '/run/systemd/resolve'];
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.next', '.gradle']);
const SCAN_ENTRIES = 50_000;

// Names the macOS profile closes (tool-boundary.mjs): .env and .env.* but not
// committed templates, credentials and credentials.*, .npmrc, .netrc, and
// auth.json at a project's root or in a dot folder.
export function credentialName(name, parent, roots) {
  if (/^\.env(\.|$)/.test(name)) return !/^\.env\.(example|sample|template|dist|defaults)$/.test(name);
  if (/^credentials(\.|$)/.test(name) || name === '.npmrc' || name === '.netrc') return true;
  return name === 'auth.json' && (roots.includes(parent) || path.basename(parent).startsWith('.'));
}

// Credential files and folders under these roots, walking at most
// SCAN_ENTRIES entries and never into dependency or build folders or links.
export function credentialFiles(roots, { limit = SCAN_ENTRIES } = {}) {
  const found = [], queue = [...roots];
  let seen = 0;
  while (queue.length && seen < limit) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(dir, entry.name);
      if (credentialName(entry.name, dir, roots)) { found.push({ path: full, directory: entry.isDirectory() }); continue; }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name)) queue.push(full);
    }
  }
  return found;
}

const depth = file => file.split('/').length;
export function bubblewrapArgs({ cwd, sdkRoot, runtimeRoot, temporary, empty, node, readOnly = false, repository = [], gitDirs = [], toolchains = [], skills = [], caches = [], references = [], network = false, credentials = [], docker = null, proxySocket = null }) {
  const exists = file => { try { fs.statSync(file); return true; } catch { return false; } };
  const readable = [...new Set([sdkRoot, runtimeRoot, path.dirname(node), ...repository, ...toolchains, ...skills, ...references, ...(readOnly ? [cwd, ...gitDirs] : [])])].filter(exists);
  const writable = [...new Set([...caches, ...(readOnly ? [] : [cwd, ...gitDirs])])].filter(exists);
  // A parent is mounted before what lies under it (a later mount covers).
  const mounts = [...readable.map(dir => ['--ro-bind', dir]), ...writable.map(dir => ['--bind', dir])]
    .sort((a, b) => depth(a[1]) - depth(b[1]) || (a[0] === '--ro-bind' ? -1 : 1));
  return [
    '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    ...(network ? [] : ['--unshare-net']),
    ...SYSTEM.filter(exists).flatMap(dir => ['--ro-bind', dir, dir]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', temporary, temporary,
    ...mounts.flatMap(([kind, dir]) => [kind, dir, dir]),
    ...credentials.filter(item => exists(item.path)).flatMap(item => item.directory ? ['--tmpfs', item.path] : ['--ro-bind', empty, item.path]),
    // An approved Docker command reaches the engine's socket (run_with_docker).
    ...(docker && exists(docker) ? ['--bind', docker, docker] : []),
    // A command without network reaches the package proxy (package-proxy.mjs)
    // through this socket; the worker forwards 127.0.0.1:3128 to it.
    ...(proxySocket && exists(proxySocket) ? ['--bind', proxySocket, '/run/piagent-proxy.sock'] : []),
    '--remount-ro', '/', '--chdir', cwd,
  ];
}

// The member's own folders for reference: the home folder's entries except
// hidden ones (and the Windows profile's, from WSL, except AppData).
export function referenceFolders(userHome, windowsHome = null) {
  const list = (home, skip = () => false) => {
    try { return fs.readdirSync(home, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && !skip(entry.name)).map(entry => path.join(home, entry.name)); }
    catch { return []; }
  };
  return [...list(userHome), ...(windowsHome ? list(windowsHome, name => /^(AppData|NTUSER|ntuser)/i.test(name)) : [])];
}
