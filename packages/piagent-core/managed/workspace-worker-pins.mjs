import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function workspaceWorkerPins(runtimeRoot) {
  const root = path.join(runtimeRoot, 'dist/workspace'), manifest = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifest)) return null;
  const source = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (source.version !== 1 || !Array.isArray(source.files) || source.files.length > 200) throw Error('workspace-worker-invalid');
  const pins = new Map([[manifest, digest(manifest)]]);
  for (const item of source.files) {
    if (typeof item.file !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(item.file)
      || item.file.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('workspace-worker-invalid');
    const file = path.join(root, item.file);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || digest(file) !== item.sha256) throw Error('workspace-worker-invalid');
    pins.set(file, item.sha256);
  }
  if (!pins.has(path.join(root, 'worker.mjs'))) throw Error('workspace-worker-invalid');
  return pins;
}

export function verifyWorkspaceWorker(pins) {
  if (!pins) throw Error('workspace-worker-unavailable');
  for (const [file, expected] of pins) if (digest(file) !== expected) throw Error('managed-runtime-changed');
}
