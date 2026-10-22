// Hidden acceptance checks for phase p5: the legacy report engine split into
// modules with byte-identical output (golden files recorded from the original),
// and the big data/stock-2025.csv imported through the library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inventory } from '../src/index.js';
import * as engine from '../src/legacy/report-engine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const golden = JSON.parse(readFileSync(new URL('./zz-legacy-golden.hidden.json', import.meta.url), 'utf8'));
const expected = JSON.parse(readFileSync(new URL('./zz-import-expected.hidden.json', import.meta.url), 'utf8'));
const lines = file => readFileSync(file, 'utf8').split('\n').length;
const walk = dir => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]);

test('p5.1 every legacy export gives byte-identical output', () => {
  assert.equal(engine.VERSION, '3.7.2');
  const names = [...new Set(golden.cases.map(c => c.name))];
  for (const name of names) assert.equal(typeof engine[name], 'function', `${name} is still exported`);
  const failures = [];
  for (const c of golden.cases) {
    const out = engine[c.name](JSON.parse(JSON.stringify(c.rows ?? golden.rows)), { ...c.opts });
    if (out !== c.output) failures.push(`${c.name}(${JSON.stringify(c.opts)})`);
  }
  assert.deepEqual(failures, [], 'outputs changed');
});

test('p5.2 the engine is split into modules under src/reports/ and the duplication is gone', () => {
  const facade = join(ROOT, 'src/legacy/report-engine.js');
  assert.ok(lines(facade) <= 150, `src/legacy/report-engine.js should only wire the modules (${lines(facade)} lines)`);
  assert.ok(existsSync(join(ROOT, 'src/reports')), 'src/reports/ exists');
  const modules = walk(join(ROOT, 'src/reports')).filter(f => f.endsWith('.js'));
  assert.ok(modules.length >= 5, `at least 5 modules in src/reports/ (found ${modules.length})`);
  for (const m of modules) assert.ok(lines(m) <= 600, `${m} has ${lines(m)} lines (max 600)`);
  const total = modules.reduce((s, m) => s + lines(m), lines(facade));
  assert.ok(total <= Math.floor(golden.originalLines * 0.6), `split total ${total} lines, max ${Math.floor(golden.originalLines * 0.6)} (60% of ${golden.originalLines})`);
});

test('p5.3 importFile loads data/stock-2025.csv in under 5 s with line-numbered errors', async () => {
  const { importFile } = await import('../src/import.js');
  const inv = new Inventory({ clock: () => '2026-01-15' });
  const t0 = performance.now();
  const result = await importFile(inv, join(ROOT, 'data/stock-2025.csv'));
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `import took ${Math.round(ms)} ms`);
  assert.equal(result.imported, expected.imported);
  assert.deepEqual(result.errors.map(e => e.line), expected.errorLines);
  for (const e of result.errors) assert.ok(typeof e.message === 'string' && e.message.trim(), `line ${e.line} has a message`);
  const byWarehouse = {};
  for (const row of inv.stockReport()) byWarehouse[row.warehouse] = (byWarehouse[row.warehouse] ?? 0) + row.onHand;
  assert.deepEqual(Object.fromEntries(Object.entries(byWarehouse).sort()), Object.fromEntries(Object.entries(expected.byWarehouse).sort()));
  for (const s of expected.samples) assert.equal(inv.onHand(s.sku, s.warehouse), s.onHand, `${s.warehouse}/${s.sku}`);
});

test('p5.4 the stricter CSV rules also hold for small inputs', () => {
  const inv = new Inventory({ clock: () => '2026-01-15' });
  const result = inv.importCsv('﻿warehouse,sku,qty,lot,expiresOn\r\nHN,A,1,L1,2025-02-30\r\nHN,A,2,L2,2024-02-29\r\nHN,A,3,L3\r\nHN,A,4,L4,,extra\r\n\r\nHN,"A, B",5,L5,\r\n');
  assert.equal(result.imported, 2);
  assert.deepEqual(result.errors.map(e => e.line), [2, 4, 5]);
  assert.equal(inv.onHand('A', 'HN'), 2);
  assert.equal(inv.onHand('A, B', 'HN'), 5);
  assert.throws(() => inv.receive('A', 1, { lot: 'L', expiresOn: '2025-04-31' }), err => err.code === 'INVALID_INPUT');
});

test('p5.5 the project has its own tests for the split engine and the import', () => {
  const own = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.js') && !f.includes('.hidden.'));
  const text = own.map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const word of ['importFile', 'stock-2025', 'report-engine']) assert.ok(text.includes(word), `no own test mentions ${word}`);
});
