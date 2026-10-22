import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const kho = (log, ...args) => spawnSync(process.execPath, ['bin/kho.js', ...args, '--log', log, '--today', '2026-03-10'], { encoding: 'utf8' });

test('bin/kho.js keeps state in its log', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'kho-')), 'log.jsonl');
  assert.equal(kho(log, 'receive', 'A', '2', '--lot', 'L').status, 0);
  assert.deepEqual(JSON.parse(kho(log, 'stock', 'A', '--json').stdout), { sku: 'A', onHand: 2, available: 2 });
  assert.equal(kho(log, 'reserve', 'o', 'A', '9').status, 1);
  assert.equal(kho(log, 'nope').status, 2);
});
