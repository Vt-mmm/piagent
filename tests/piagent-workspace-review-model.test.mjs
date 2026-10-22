import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { editorReviewHunks } from '../packages/piagent-webui/client/src/workspace-review-model.ts';

test('editor review requires exact clean bytes and keeps only the scoped digest and agent hunk', () => {
  const diff = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/diff-v1.valid.json', import.meta.url)));
  const digest = 'a'.repeat(64), file = 'src/a.ts';
  diff.file.path = file; diff.file.currentDigest = `sha256:${digest}`;
  diff.agentHunkRefs = [diff.hunks[0].hunkRef];
  const read = (value = diff, path = file, hash = digest, clean = true, kept = new Set()) => editorReviewHunks(value, path, hash, clean, kept);
  assert.deepEqual(read(), [diff.hunks[0]]);
  assert.deepEqual(read(diff, file, digest, false), []);
  assert.deepEqual(read(diff, 'src/b.ts'), []);
  assert.deepEqual(read(diff, file, 'b'.repeat(64)), []);
  assert.deepEqual(read(diff, file, null), []);
  assert.deepEqual(read(diff, file, digest, true, new Set([`${file}:${digest}:${diff.hunks[0].hunkRef}`])), []);
  assert.equal(read(diff, file, digest, true, new Set([`${file}:${'b'.repeat(64)}:${diff.hunks[0].hunkRef}`])).length, 1);
  assert.deepEqual(read({ ...diff, agentHunkRefs: [] }), []);
  assert.deepEqual(read({ ...diff, redaction: { ...diff.redaction, applied: true } }), []);
  assert.deepEqual(read({ ...diff, truncation: { ...diff.truncation, truncated: true } }), []);
});

test('kept hunk identities survive view consumers and remain scoped to session, file and digest', async () => {
  const { keepWorkspaceHunk, keptWorkspaceHunks } = await import('../packages/piagent-webui/client/src/workspace-review-kept.ts');
  keepWorkspaceHunk('review.session.one', 'a.txt', 'digest.one', 'hunk.one');
  const readAgain = keptWorkspaceHunks('review.session.one');
  assert.equal(readAgain.has('a.txt:digest.one:hunk.one'), true);
  assert.equal(readAgain.has('a.txt:digest.two:hunk.one'), false);
  assert.equal(readAgain.has('b.txt:digest.one:hunk.one'), false);
  assert.equal(keptWorkspaceHunks('review.session.two').size, 0);
  keepWorkspaceHunk('review.session.one', 'b.txt', 'digest.two', 'hunk.two');
  assert.equal(keptWorkspaceHunks('review.session.one').size, 2);
  assert.equal(readAgain.size, 1, 'published snapshots are immutable');
});
