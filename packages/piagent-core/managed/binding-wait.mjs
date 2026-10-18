import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Agent Watch pins the company launcher and its own broker by sha256. A
// Piagent update replaces the launcher in place, an Agent Watch update
// (Sparkle) replaces the broker, and Watch rewrites the binding on its next
// sync (every ~5 min, on wake or network change; up to ~70 s after its own
// update). Until then the launch waits for the new binding instead of failing;
// it never runs a launcher or broker whose hash differs from the binding.

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// What differs between the binding and this process: null when every pinned
// path and hash matches, 'entrypoint' when only the launcher's contents
// changed (same path, same Node, same broker), 'broker' when only the
// broker's contents changed (same path, same Node, same launcher), 'other'
// for anything else.
export function bindingMismatch(config, { self, node }) {
  const hash = file => { try { return digest(file); } catch { return null; } };
  if (config?.schema_version !== 1 || config.model !== 'agent-watch-auto' || !/^[a-f0-9]{64}$/.test(config.profile_id)
    || config.entrypoint !== self || config.node !== node || hash(config.node) !== config.node_sha256) return 'other';
  const entrypoint = hash(config.entrypoint) === config.entrypoint_sha256, broker = hash(config.broker) === config.broker_sha256;
  return entrypoint && broker ? null : entrypoint ? 'broker' : broker ? 'entrypoint' : 'other';
}

// The launcher at the bound path is a Piagent release installed after Watch
// wrote the binding (ctime: install time, whatever mtime the package carries).
export function installedAfterBinding(configPath, entrypoint) {
  try {
    const root = path.dirname(path.dirname(entrypoint));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg?.name !== '@piagent/platform' || !/^\d+\.\d+\.\d+/.test(String(pkg.version))) return false;
    return fs.statSync(entrypoint).ctimeMs > fs.statSync(configPath).mtimeMs;
  } catch { return false; }
}

export const AGENT_WATCH_BUNDLE_ID = 'com.vtamm.claudewatch.ClaudeWatchMac';
const plistValue = (plist, key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();

// The broker at the bound path is still the Agent Watch app's own executable
// (…/X.app/Contents/MacOS/<CFBundleExecutable> of Agent Watch's bundle id),
// replaced after Watch wrote the binding: an Agent Watch update (ctime: when
// Sparkle moved the new app in). macOS only; nothing else counts.
export function brokerUpdatedAfterBinding(configPath, broker, { platform = process.platform, read = plistValue } = {}) {
  try {
    if (platform !== 'darwin' || typeof broker !== 'string' || fs.realpathSync(broker) !== broker) return false;
    const contents = path.dirname(path.dirname(broker));
    if (path.basename(path.dirname(broker)) !== 'MacOS' || path.basename(contents) !== 'Contents' || !path.dirname(contents).endsWith('.app')) return false;
    const plist = path.join(contents, 'Info.plist');
    if (read(plist, 'CFBundleIdentifier') !== AGENT_WATCH_BUNDLE_ID || read(plist, 'CFBundleExecutable') !== path.basename(broker)) return false;
    return fs.statSync(broker).ctimeMs > fs.statSync(configPath).mtimeMs;
  } catch { return false; }
}

const processList = () => execFileSync('/bin/ps', ['-axo', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });

// Whether the Agent Watch app (the broker executable, not one of its
// broker/helper subprocesses) is running: true, false, or null when this
// computer cannot tell (WSL: Watch runs on the Windows side).
export function agentWatchRunning(broker, { platform = process.platform, list = processList } = {}) {
  if (platform !== 'darwin' || typeof broker !== 'string') return null;
  let lines;
  try { lines = list().split('\n'); } catch { return null; }
  return lines.some(line => {
    if (!line.startsWith(broker)) return false;
    const rest = line.slice(broker.length);
    return rest === '' || (rest.startsWith(' ') && !/^ (managed-broker|managed-authorize|credential)\b/.test(rest));
  });
}

// Polls until `current()` returns a binding that passes every check, or the
// time is up (null). `waiting(watch)` is told whether Watch runs, each time
// that changes.
export async function awaitRebind({ current, running, waiting = () => {}, timeoutMs = 90_000, intervalMs = 1000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let shown;
  for (const started = now(); ;) {
    const state = running();
    if (state !== shown) { shown = state; waiting(state); }
    if (now() - started >= timeoutMs) return null;
    await sleep(intervalMs);
    const next = current();
    if (next) return next;
  }
}
