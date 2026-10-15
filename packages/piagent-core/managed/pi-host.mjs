import fs from 'node:fs';
import path from 'node:path';

// The Pi host company sessions are qualified on: the package's peer
// dependency, which piagent-setup installs and CI tests. One place, so moving
// to a new host is one change (scripts/verify-release-identity.mjs keeps its
// own copy on purpose, to catch a pin moved by accident).
export const PI_HOST_VERSION = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).peerDependencies['@earendil-works/pi-coding-agent'];

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
