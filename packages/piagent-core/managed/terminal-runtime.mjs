import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { BWRAP } from './linux-sandbox.mjs';

const require = createRequire(import.meta.url);
const VERSION = '1.2.0-beta.15';
const fail = () => { throw new Error('managed-terminal-runtime-invalid'); };

// Inspect code without loading the native addon on the company Gateway host.
// The entire platform package is pinned, including its JS and prebuilt binary.
function inventory(root) {
  const entries = [], queue = [root];
  let bytes = 0, visited = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) fail();
    for (const name of fs.readdirSync(directory).sort()) {
      if (++visited > 128) fail();
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) { queue.push(file); continue; }
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024) fail();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail();
        const digest = createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
        entries.push([path.relative(root, file), digest, opened.mode & 0o777]);
      } finally { fs.closeSync(fd); }
    }
  }
  return JSON.stringify(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

export function companyTerminalRuntime({ platform = process.platform, arch = process.arch,
  bubblewrap = BWRAP, resolve = specifier => createRequire(require.resolve('@lydell/node-pty')).resolve(specifier) } = {}) {
  if (platform !== 'linux') throw new Error(platform === 'darwin' ? 'managed-terminal-seatbelt-unavailable' : 'managed-terminal-platform-unavailable');
  if (!bubblewrap) throw new Error('managed-terminal-bubblewrap-unavailable');
  if (!['arm64', 'x64'].includes(arch)) throw new Error('managed-terminal-platform-unavailable');
  const name = `@lydell/node-pty-linux-${arch}`;
  let entry;
  try { entry = fs.realpathSync(resolve(name)); }
  catch { throw new Error('managed-terminal-native-unavailable'); }
  const root = path.dirname(path.dirname(entry));
  if (entry !== path.join(root, 'lib/index.js')) fail();
  const pinned = inventory(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== VERSION || manifest.dependencies && Object.keys(manifest.dependencies).length) fail();
  if (!fs.statSync(path.join(root, `prebuilds/linux-${arch}/pty.node`)).isFile()) fail();
  return Object.freeze({ entry, root, version: VERSION,
    assertCurrent() { if (inventory(root) !== pinned) throw new Error('managed-terminal-runtime-changed'); } });
}

export function companyTerminalDiagnostic(options = {}) {
  let reasonCode = null;
  try { companyTerminalRuntime(options); }
  catch (error) { reasonCode = /^managed-terminal-/.test(error.message) ? error.message : 'managed-terminal-runtime-invalid'; }
  return { supported: reasonCode === null, reasonCode, platform: options.platform ?? process.platform,
    scope: 'company', probe: 'runtime-files', ptySpawnVerified: false };
}
