import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pinned = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).peerDependencies['@earendil-works/pi-coding-agent'];
const versionOf = root => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return null; } };

// The pinned Pi host the managed runtime tests drive. PI_MANAGED_TEST_SDK
// wins; then the installer's prefix (~/.pi/npm-global); then the npm global
// root, which is where CI and Homebrew-style installs put it, when it holds
// the pinned version, then Piagent's private copy (another version would fail the SDK qualification for a
// reason that is not the test's). Before, most tests looked only at the
// installer's prefix and skipped themselves everywhere else, CI included.
export function piSdkRoot() {
  if (process.env.PI_MANAGED_TEST_SDK) return process.env.PI_MANAGED_TEST_SDK;
  const personal = path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
  if (fs.existsSync(personal)) return personal;
  try {
    const global = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim(), '@earendil-works/pi-coding-agent');
    if (versionOf(global) === pinned) return global;
  } catch { /* npm unavailable: fall back to the installer's prefix */ }
  // A machine whose own pi is newer keeps the pinned host privately (pi-host.mjs).
  const own = path.join(os.homedir(), '.piagent/pi-host', pinned, 'node_modules/@earendil-works/pi-coding-agent');
  if (versionOf(own) === pinned) return own;
  return personal;
}
