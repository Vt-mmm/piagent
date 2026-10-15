import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { workflowPolicy } from '../packages/piagent-core/managed/workflow.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// docs/harness-conformance.md names, for every setting of a team's Harness,
// the tests that prove Piagent runs it. This file keeps that page honest.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'docs/harness-conformance.md'), 'utf8');

// The Harness settings, as agent-studio/internal/runs/profile.go defines
// Configuration, Role and Workflow. A setting added there needs a section.
const SETTINGS = ['main.mode', 'main.model_ids', 'main.effort', 'scout`, `research`, `verify`, `review', 'helper.mode', 'helper.effort',
  'workflow', 'workflow.plan', 'workflow.verify', 'workflow.review', 'workflow.max_fix_loops', 'fast_mode'];

function sections() {
  const out = new Map(); let current = null;
  for (const line of page.split('\n')) {
    const heading = line.match(/^### `(.+)`\s*$/);
    if (heading) { current = heading[1]; out.set(current, []); continue; }
    const ref = line.match(/^- Piagent: `([\w-]+)` › (.+)$/);
    if (ref && current) out.get(current).push({ file: ref[1], title: ref[2].trim() });
  }
  return out;
}
// Test titles as written in a test file, escapes read.
function titles(file) {
  const source = fs.readFileSync(path.join(root, 'tests', `${file}.test.mjs`), 'utf8');
  return new Set([...source.matchAll(/\btest\((["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map(m => m[2].replace(/\\(.)/g, '$1')));
}

test('every Harness setting has a section that names Piagent tests, and every named test exists', () => {
  const found = sections();
  for (const setting of SETTINGS) {
    assert.ok(found.has(setting), `docs/harness-conformance.md has no section for ${setting}`);
    assert.ok(found.get(setting).length > 0, `${setting} names no Piagent test`);
  }
  const cache = new Map();
  for (const [setting, refs] of found) for (const { file, title } of refs) {
    assert.ok(fs.existsSync(path.join(root, 'tests', `${file}.test.mjs`)), `${setting}: tests/${file}.test.mjs does not exist`);
    if (!cache.has(file)) cache.set(file, titles(file));
    assert.ok(cache.get(file).has(title), `${setting}: tests/${file}.test.mjs has no test "${title}"`);
  }
});

// Most conformance tests drive a real Pi SDK session and skip without the
// pinned host. Where it must be installed (macOS in CI, or on request) a
// missing host fails here instead of turning the Harness tests into skips.
test('the pinned Pi host is present where the Harness tests must run', () => {
  const required = process.platform === 'darwin' && (process.env.CI === 'true' || process.env.PIAGENT_REQUIRE_PI_SDK === '1');
  if (!required) return;
  const sdk = piSdkRoot();
  assert.ok(fs.existsSync(path.join(sdk, 'package.json')), `no Pi host at ${sdk}: set PI_MANAGED_TEST_SDK or install the pinned @earendil-works/pi-coding-agent globally`);
});

test('max_fix_loops is read within 0 to 3 and falls back to 2', () => {
  const loops = value => workflowPolicy({ harness: { configuration: { main: {}, review: { model_ids: ['r'] }, workflow: { plan: 'require', verify: 'require', review: 'require', max_fix_loops: value } } } }).maxFixLoops;
  assert.deepEqual([0, 1, 2, 3].map(loops), [0, 1, 2, 3]);
  for (const value of [4, -1, 1.5, '3', null, undefined]) assert.equal(loops(value), 2, String(value));
});

test('a helper role already running in the conversation is not started twice', async () => {
  // Only what delegate reads before it asks Studio: the run, its helpers, the manifest.
  const running = { grant: { run_id: 'run' }, helpers: new Map([['review', Promise.resolve()]]) };
  await assert.rejects(ManagedSession.prototype.delegate.call(running, { role: 'review', task: 'Review the patch.' }), /^Error: managed-helper-unavailable$/);
  // The same call with no review running gets past that check (and fails later, on what this stub lacks).
  const idle = { grant: { run_id: 'run' }, helpers: new Map() };
  await assert.rejects(ManagedSession.prototype.delegate.call(idle, { role: 'review', task: 'Review the patch.' }), error => !/managed-helper-unavailable/.test(String(error)));
});
