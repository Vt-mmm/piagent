import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Pi host company sessions are qualified on: the package's peer
// dependency, which piagent-setup installs and CI tests. One place, so moving
// to a new host is one change (scripts/verify-release-identity.mjs keeps its
// own copy on purpose, to catch a pin moved by accident).
export const PI_HOST_VERSION = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).peerDependencies?.['@earendil-works/pi-coding-agent'];

const HOST_NAME = '@earendil-works/pi-coding-agent';

// A package the host depends on (@earendil-works/pi-ai), found the way Node
// finds it from the host: in its own node_modules (0.87.1 shipped a
// shrinkwrap that nested it there), else in a parent's (1.x hoists it).
export function hostPackage(sdk, name) {
  for (let dir = sdk; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`managed-sdk-dependency-missing: ${name}`);
  }
}

// A member may run their own Pi, newer than the pinned host (they keep up
// with Pi themselves). Piagent never replaces it: the pinned host is installed
// beside it, privately, under ~/.piagent/pi-host/<version>, and company
// sessions, the dashboard and `piagent pi` run that one.
export function privateHostPrefix(version = PI_HOST_VERSION, home = os.homedir()) {
  return path.join(home, '.piagent', 'pi-host', version);
}

// The private host's package root when it holds exactly `version`, else null.
export function privateHostRoot(version = PI_HOST_VERSION, home = os.homedir()) {
  const root = path.join(privateHostPrefix(version, home), 'node_modules', ...HOST_NAME.split('/'));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return manifest.name === HOST_NAME && manifest.version === version ? fs.realpathSync(root) : null;
  } catch { return null; }
}

// The host's command line entry (`pi`), as its manifest names it.
export function hostCli(root) {
  const bin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).bin;
  return path.join(root, typeof bin === 'string' ? bin : bin.pi);
}

const parts = (version) => String(version).split(/[+-]/)[0].split('.').map(Number);
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let index = 0; index < 3; index += 1) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
}

// What setup does with the `pi` on PATH: nothing when it is the pinned host;
// keep a newer one (the member's own) and install the pinned host privately;
// replace a missing or older one, as Piagent itself put it there.
export function hostPlan(current, pinned = PI_HOST_VERSION) {
  if (current === pinned) return 'current';
  if (current && compareVersions(current, pinned) > 0) return 'private';
  return 'global';
}

// Installs the pinned host into its private prefix (no install scripts, as
// the global install). Returns the package root.
export function installPrivateHost({ version = PI_HOST_VERSION, home = os.homedir(), npm = 'npm', dryRun = false, log = () => {} } = {}) {
  const existing = privateHostRoot(version, home);
  if (existing) return existing;
  const prefix = privateHostPrefix(version, home);
  const args = ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `${HOST_NAME}@${version}`];
  log(`${dryRun ? 'DRY RUN: ' : ''}${npm} ${args.join(' ')}`);
  if (dryRun) return path.join(prefix, 'node_modules', ...HOST_NAME.split('/'));
  fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const result = spawnSync(npm, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  const root = privateHostRoot(version, home);
  if (result.status !== 0 || !root) throw new Error(`pi-host-private-install-failed: ${HOST_NAME}@${version}`);
  return root;
}
