import test from 'node:test';
import assert from 'node:assert/strict';
import {afterTools, jobTitle, purposeHeaders} from '../packages/piagent-core/managed/call-purpose.mjs';

const user = {role: 'user', content: 'fix the login bug'};
const answer = (...names) => ({role: 'assistant', content: [{type: 'text', text: 'looking'}, ...names.map((name) => ({type: 'toolCall', name, arguments: {}}))]});
const result = {role: 'toolResult', content: [{type: 'text', text: 'ok'}]};

test('a call names what it is for: answer, step after tools, harness turn, summary, subagent brief', () => {
  const owner = {}, runtime = {}, helper = {};
  assert.deepEqual(purposeHeaders(owner, runtime, 'main', {systemPrompt: 'You are the company agent', messages: [user]}), {'X-Agent-Purpose': 'answer'});
  assert.deepEqual(purposeHeaders(owner, runtime, 'main', {messages: [user, answer('read', 'read', 'read', 'bash', 'mcp.tool'), result]}),
    {'X-Agent-Purpose': 'tool_step', 'X-Agent-After': 'read:3,bash,other'});
  owner.nextPurpose = 'harness';
  assert.deepEqual(purposeHeaders(owner, runtime, 'main', {messages: [user, answer(), {role: 'user', content: 'run the checks'}]}), {'X-Agent-Purpose': 'harness'});
  assert.equal(owner.nextPurpose, null, 'the harness mark is used once');
  // The round the harness starts for a checklist with open steps.
  owner.nextPurpose = 'continue';
  assert.deepEqual(purposeHeaders(owner, runtime, 'main', {messages: [user, answer(), {role: 'custom', content: 'Harness: your checklist still has 1 open step(s)'}]}), {'X-Agent-Purpose': 'continue'});
  assert.equal(owner.nextPurpose, null);
  assert.equal(purposeHeaders(owner, runtime, 'main', {systemPrompt: 'You are a context summarization assistant. Your task…', messages: [user]})['X-Agent-Purpose'], 'summary');
  // Pi folds the system prompt into a leading system message before the provider call.
  assert.equal(purposeHeaders(owner, runtime, 'main', {messages: [{role: 'system', content: 'You are a context summarization assistant. Your task…'}, user]})['X-Agent-Purpose'], 'summary');
  assert.equal(purposeHeaders(owner, runtime, 'main', {messages: [{role: 'system', content: [{type: 'text', text: 'You are a context summarization assistant.'}]}, user]})['X-Agent-Purpose'], 'summary');
  assert.equal(purposeHeaders(owner, runtime, 'main', {messages: [{role: 'system', content: 'You are the company agent'}, user]})['X-Agent-Purpose'], 'answer');
  owner.jobTitles = new WeakMap([[helper, 'Tìm chỗ lưu token đăng nhập']]);
  assert.deepEqual(purposeHeaders(owner, helper, 'scout', {messages: [user]}),
    {'X-Agent-Purpose': 'brief', 'X-Agent-Task': encodeURIComponent('Tìm chỗ lưu token đăng nhập')});
  assert.deepEqual(purposeHeaders(owner, helper, 'scout', {messages: [user, answer('grep'), result]}), {'X-Agent-Purpose': 'tool_step', 'X-Agent-After': 'grep'});
});

test('a job title is one short line: the given one, else the brief\'s first line', () => {
  assert.equal(jobTitle('Goal: find X\nDetails…', '  Find where tokens live  '), 'Find where tokens live');
  assert.equal(jobTitle('\n\n  Goal: find X\nDetails…', ''), 'Goal: find X');
  assert.equal(jobTitle('a\tb\u0007c'), 'a b c');
  const long = jobTitle('x'.repeat(300));
  assert.equal(long.length, 100); assert.ok(long.endsWith('…'));
  assert.equal(afterTools(answer()), '');
  assert.equal(afterTools(answer(...Array.from({length: 10}, (_, i) => 't' + i))).split(',').length, 8);
});
