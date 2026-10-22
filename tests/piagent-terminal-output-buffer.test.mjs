import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalOutputBuffer } from '../packages/piagent-webui/gateway/terminal-output-buffer.ts';

test('terminal capture redacts credentials across chunks and ANSI before agent attachment', () => {
  const buffer=new TerminalOutputBuffer(), token='sk-'+ 'a'.repeat(32);
  buffer.append('normal output\r\n');buffer.append(token.slice(0,9));buffer.append('\x1b[31m'+token.slice(9)+'\x1b[0m\r\n');
  assert.ok(buffer.snapshot().text.includes('[REDACTED_SECRET]'));
  assert.ok(!buffer.snapshot().text.includes('a'.repeat(20)));
  assert.ok(buffer.forAgent().text.includes('normal output'));
  assert.ok(!buffer.forAgent().text.includes('\x1b'));
  const partial=new TerminalOutputBuffer();partial.append(token);
  assert.equal(partial.forAgent().text,'[REDACTED_SECRET]');
});

test('terminal capture masks unfinished and complete private keys, including oversized blocks', () => {
  const buffer=new TerminalOutputBuffer();
  buffer.append('-----BEGIN PRIVATE KEY-----\nprivateMaterial\n');
  assert.ok(!buffer.snapshot().text.includes('privateMaterial'));
  buffer.append('X'.repeat(70000)+'\n');buffer.append('-----END PRIVATE KEY-----\nnext output\n');
  assert.ok(!buffer.forAgent().text.includes('XXXXX'));
  assert.ok(buffer.forAgent().text.includes('next output'));
});

test('terminal replay is byte bounded, keeps Unicode intact and drops overlong incomplete lines', () => {
  const buffer=new TerminalOutputBuffer();
  buffer.append(('tiếng Việt\r\n').repeat(10000));
  let snapshot=buffer.snapshot();assert.ok(Buffer.byteLength(snapshot.text)<=65536);assert.equal(snapshot.truncated,true);
  assert.ok(!snapshot.text.includes('\ufffd'));
  buffer.append('z'.repeat(70000));buffer.append('still part of omitted line\nuseful next line\n');
  snapshot=buffer.snapshot();assert.ok(!snapshot.text.includes('still part'));assert.ok(snapshot.text.endsWith('useful next line\n'));
  assert.ok(Buffer.byteLength(snapshot.text)<=65536);
});
