import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// What a browser downloads before the dashboard can draw: the scripts and
// styles index.html names, gzipped as they travel. A new dependency in the
// first screen shows up here instead of as a slower first open. Lazy chunks
// (editor, terminal, markdown) are not counted.
const BUDGET_GZIP_BYTES = 215 * 1024;
const client = path.resolve('packages/piagent-webui/dist/client');

test('the dashboard first screen stays inside its download budget', { skip: !fs.existsSync(path.join(client, 'index.html')) && 'build the dashboard first' }, () => {
  const html = fs.readFileSync(path.join(client, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.length > 0, 'index.html names its entry assets');
  const sizes = assets.map(asset => [asset, zlib.gzipSync(fs.readFileSync(path.join(client, asset))).length]);
  const total = sizes.reduce((sum, [, size]) => sum + size, 0);
  assert.ok(total <= BUDGET_GZIP_BYTES, `first screen is ${Math.round(total / 1024)} KiB gzipped, over the ${BUDGET_GZIP_BYTES / 1024} KiB budget: ${JSON.stringify(sizes)}`);
});
