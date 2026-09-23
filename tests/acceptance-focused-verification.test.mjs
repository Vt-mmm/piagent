import assert from 'node:assert/strict';
import test from 'node:test';
import {
  observedFocusedTestSummary, unresolvedFocusedVerification as missing,
  retainFocusedVerification as retain
} from '../packages/piagent-core/extensions/acceptance-focused-verification.js';

const digest = 'wt-content-v2:' + 'a'.repeat(64);
const revision = 'workspace-revision-v1:' + 'b'.repeat(64);
const failure = { command: 'node --test focused.test.mjs', observed: true,
  matchedProfileCommand: false, exitCode: 1, preWorkingTreeDigest: digest,
  workingTreeDigest: digest, preWorkspaceRevisionDigest: revision, workspaceRevisionDigest: revision };

test('only observed test summaries add focused verification obligations', () => {
  assert.equal(observedFocusedTestSummary('# tests 1\n# pass 0\n# fail 1'), true);
  assert.equal(observedFocusedTestSummary('ℹ tests 3\nℹ pass 3\nℹ fail 0'), true);
  for (const output of ['command failed', '# tests 0\n# pass 0\n# fail 0', '# pass 0\n# fail 1']) {
    assert.equal(observedFocusedTestSummary(output), false);
  }
  assert.deepEqual(missing([{ ...failure, observed: false }], digest, revision), []);
  assert.deepEqual(missing([{ ...failure, matchedProfileCommand: true }], digest, revision), []);
});

test('unrelated successful verification cannot clear a focused failure', () => {
  const configured = { ...failure, command: 'npm test', matchedProfileCommand: true, exitCode: 0 };
  assert.deepEqual(missing([failure, configured], digest, revision), [failure.command]);
  assert.deepEqual(missing([failure, { ...failure, command: 'node other.mjs', exitCode: 0 }], digest, revision), [failure.command]);
});

test('recovery requires a successful rerun bound to the current source before and after execution', () => {
  const passed = { ...failure, exitCode: 0 };
  assert.deepEqual(missing([failure, passed], digest, revision), []);
  for (const field of ['preWorkingTreeDigest', 'workingTreeDigest', 'preWorkspaceRevisionDigest', 'workspaceRevisionDigest']) {
    assert.deepEqual(missing([failure, { ...passed, [field]: 'stale' }], digest, revision), [failure.command], field);
  }
  assert.deepEqual(missing([failure, { ...passed, isError: true }], digest, revision), [failure.command]);
  assert.deepEqual(missing([failure, passed], 'unknown', revision), [failure.command]);
  assert.deepEqual(missing([failure, passed, failure], digest, revision), [failure.command]);
});

test('history compaction and serialized resume retain unresolved failures', () => {
  const routine = Array.from({ length: 150 }, () => ({ ...failure, command: 'npm test', matchedProfileCommand: true, exitCode: 0 }));
  const saved = retain([failure, ...routine], digest, revision);
  assert.equal(saved.length, 101);
  assert.deepEqual(missing(JSON.parse(JSON.stringify(saved)), digest, revision), [failure.command]);
  const recovered = retain([...saved, { ...failure, exitCode: 0 }], digest, revision);
  assert.equal(recovered.length, 100);
  assert.deepEqual(missing(recovered, digest, revision), []);
  const stale = retain([...saved, { ...failure, exitCode: 0, workspaceRevisionDigest: 'stale' }], digest, revision);
  assert.deepEqual(missing(stale, digest, revision), [failure.command]);
});

test('the recent-history limit does not silently discard distinct active failures', () => {
  const failures = Array.from({ length: 120 }, (_, i) => ({ ...failure, command: `node focused-${i}.mjs` }));
  assert.deepEqual(missing(retain(failures, digest, revision), digest, revision), failures.map(f => f.command));
});
