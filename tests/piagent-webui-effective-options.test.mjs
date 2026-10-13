import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectEffectiveSessionOptions} from '../packages/piagent-webui/gateway/session-effective-options.ts';

const session = (thinking, extra = {}) => ({model: {provider: 'openai', id: 'gpt'}, getThinkingLevel: () => thinking, ...extra});

test('a created session must run the model and thinking level that were asked for', () => {
  assert.equal(inspectEffectiveSessionOptions(session('high'), null, 'high').state, 'confirmed');
  const other = inspectEffectiveSessionOptions(session('max'), null, 'high');
  assert.equal(other.state, 'mismatch'); assert.equal(other.reasonCode, 'session-thinking-mismatch');
  assert.equal(inspectEffectiveSessionOptions(session('high'), 'another/model', 'high').reasonCode, 'session-model-mismatch');
});

test('a company conversation is created at the level its Harness allows', () => {
  // The page asked for high from the Harness before; the Harness now fixes max.
  const company = inspectEffectiveSessionOptions(session('max', {managedExecution: true}), null, 'high');
  assert.deepEqual({state: company.state, thinkingLevel: company.thinkingLevel, reasonCode: company.reasonCode}, {state: 'confirmed', thinkingLevel: 'max', reasonCode: null});
  assert.equal(inspectEffectiveSessionOptions(session('max', {managedExecution: true}), 'another/model', 'high').reasonCode, 'session-model-mismatch');
});
