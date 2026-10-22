import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sessionAuthoredHunkRefs } from '../packages/piagent-core/runtime/inspection/session-hunk-provenance.ts';
const sha = text => createHash('sha256').update(text).digest('hex');
const observation = (before, after) => ({ path: 'a.txt', baseline: { content: before, digest: sha(before) }, currentDigest: sha(after), toolCallId: 'tool', evidenceRef: 'evidence' });
const patch = (...hunks) => ({ header: Buffer.alloc(0), hunks: hunks.map(([hunkRef, text]) => ({ hunkRef, bytes: Buffer.from(text) })) });
test('agent hunk qualifies while a separate pre-existing member hunk stays excluded', () => {
  const before = 'one\ncontext\nmember\n', after = 'agent\ncontext\nmember\n';
  const hunks = patch(['agent', '@@ -1 +1 @@\n-one\n+agent\n'], ['member', '@@ -3 +3 @@\n-original\n+member\n']);
  assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after, hunks), ['agent']);
  assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after + 'concurrent\n', hunks), []);
});
test('mixed hunks and edits overwriting a member line cannot revert member changes to index', () => {
  const before = 'one\nmember\n', after = 'agent\nmember\n';
  const mixed = patch(['mixed', '@@ -1,2 +1,2 @@\n-one\n-original\n+agent\n+member\n']);
  assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after, mixed), []);
  assert.deepEqual(sessionAuthoredHunkRefs(observation('member\n', 'agent\n'), 'agent\n', patch(['same-line', '@@ -1 +1 @@\n-original\n+agent\n'])), []);
});
test('insertions, deletions, and index line shifts are bound to current positions', () => {
  const before = 'a\nb\nc\n', after = 'a\nnew\nb\n';
  const hunks = patch(['insert', '@@ -1,0 +2 @@\n+new\n'], ['delete', '@@ -3 +3,0 @@\n-c\n']);
  // A zero-count new range names the line preceding the deletion.
  assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after, hunks), ['insert', 'delete']);
  const context = patch(['both', '@@ -1,3 +1,3 @@\n a\n+new\n b\n-c\n']);
  assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after, context), ['both']);
});
test('truncated, redacted or newline-normalized patches never gain authority', () => {
  const before = 'a\n', after = 'b\n', proof = observation(before, after);
  assert.deepEqual(sessionAuthoredHunkRefs(proof, after, patch(['truncated', '@@ -1,2 +1 @@\n-a\n+b\n'])), []);
  assert.deepEqual(sessionAuthoredHunkRefs(proof, after, patch(['redacted', '@@ -1 +1 @@\n-[redacted]\n+b\n'])), []);
  assert.deepEqual(sessionAuthoredHunkRefs(observation('a\r\n', 'b\r\n'), 'b\r\n', patch(['crlf', '@@ -1 +1 @@\n-a\n+b\n'])), []);
});

test('real Git index hunks distinguish agent edits from an existing member patch', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hunk-git-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(cwd, 'a.txt'), original); git('add', 'a.txt');
  const before = original.replace('line 25\n', 'member 25\n'), after = before.replace('line 3\n', 'agent 3\n');
  fs.writeFileSync(path.join(cwd, 'a.txt'), after);
  const raw = git('diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--', 'a.txt');
  const sections = raw.split(/(?=^@@ )/m).slice(1);
  assert.equal(sections.length, 2);
  const authority = patch(...sections.map((section, index) => [`hunk${index}`, section]));
  assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after, authority), ['hunk0']);
});

test('real Git hunks preserve CRLF, mixed endings and missing final newline byte authority', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hunk-endings-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  const cases = [
    ['a\r\nb\r\n', 'agent\r\nb\r\n'],
    ['a\r\nb\nc\r\n', 'a\r\nagent\nc\r\n'],
    ['a\nb', 'a\nagent'],
    ['a\n', 'a'],
    ['a', 'a\n'],
    ['a\r\n', 'a\n'],
  ];
  for (const [before, after] of cases) {
    fs.writeFileSync(path.join(cwd, 'a.txt'), before); git('add', 'a.txt');
    fs.writeFileSync(path.join(cwd, 'a.txt'), after);
    const raw = git('diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--', 'a.txt');
    const sections = raw.split(/(?=^@@ )/m).slice(1);
    assert.ok(sections.length);
    const authority = patch(...sections.map((section, index) => [`hunk${index}`, section]));
    assert.deepEqual(sessionAuthoredHunkRefs(observation(before, after), after, authority), ['hunk0'], JSON.stringify([before, after]));
    // A different member preimage must never inherit the index's revert authority.
    assert.deepEqual(sessionAuthoredHunkRefs(observation('member\n', after), after, authority), []);
  }
});

test('malformed or duplicated EOF markers fail closed', () => {
  for (const text of [
    '@@ -1 +1 @@\n\\ No newline at end of file\n-a\n+b\n',
    '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n\\ No newline at end of file\n+b\n',
    '@@ -1 +1 @@\n-a\n+b\n\\ Unknown marker\n',
  ]) assert.deepEqual(sessionAuthoredHunkRefs(observation('a', 'b\n'), 'b\n', patch(['bad', text])), []);
});
