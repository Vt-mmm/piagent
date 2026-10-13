import test from 'node:test';
import assert from 'node:assert/strict';
import {sendToolFailures, toolFailure, toolFailureCode, trackToolFailures} from '../packages/piagent-core/managed/tool-failures.mjs';

const failed = text => ({content: [{type: 'text', text}]});
function session() {
  const listeners = [];
  return {subscribe: listener => listeners.push(listener), emit: event => listeners.forEach(listener => listener(event))};
}
// A Studio that answers each request with the next status and keeps the bodies.
function studio(...statuses) {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({url, token: init.headers.Authorization, body: JSON.parse(init.body)}); return {status: statuses.shift() ?? 204, get ok() { return this.status < 300; }}; };
  return {requests, fetchImpl};
}

test('a failure is named by the runtime\'s code, else by how the command ended', () => {
  assert.equal(toolFailureCode('managed-docker-unreachable: Lệnh chạy với Docker…\nCannot connect to the Docker daemon\n\nCommand exited with code 1'), 'managed_docker_unreachable');
  assert.equal(toolFailureCode('web-search-failed: search_unavailable'), 'web_search_failed');
  assert.equal(toolFailureCode('npm ERR! missing script: build\n\nCommand exited with code 127'), 'exit_127');
  assert.equal(toolFailureCode('…\n\nCommand timed out after 120 seconds'), 'timeout');
  assert.equal(toolFailureCode('the log says managed-docker-unreachable somewhere'), 'error');
});

test('a kept failure has the command and the end of the output, without secrets or the home folder', () => {
  const output = `pull access denied for /Users/an/app, token ghp_${'a'.repeat(36)}\n${'x'.repeat(5000)}\nfinal line\n\nCommand exited with code 1`;
  const kept = toolFailure({tool: 'run_with_docker', role: 'main', args: {command: 'docker compose -f /Users/an/app/compose.yaml up -d'}, result: failed(output), startedAt: 1000, endedAt: 4500, engine: {socket: '/s'}, home: '/Users/an'});
  assert.equal(kept.tool, 'run_with_docker'); assert.equal(kept.code, 'exit_1'); assert.equal(kept.engine, 'used'); assert.equal(kept.duration_ms, 3500);
  assert.equal(kept.input, 'docker compose -f ~/app/compose.yaml up -d');
  assert.ok(kept.error.startsWith('pull access denied for ~/app') && kept.error.endsWith('final line\n\nCommand exited with code 1'));
  assert.ok(!kept.error.includes('ghp_aaaa') && kept.error.length < 3200 && kept.error.includes('characters left out'));
  // A search query or a brief is prompt text: only a command, path or address is kept.
  assert.equal(toolFailure({tool: 'web_search', role: 'research', args: {query: 'our secret roadmap'}, result: failed('web-search-empty'), endedAt: 1}).input, undefined);
  assert.equal(toolFailure({tool: 'bash', role: 'main', args: {command: 'docker ps'}, result: failed('managed-docker-unavailable: …'), endedAt: 1}).engine, 'none');
  assert.equal(toolFailure({tool: 'Weird Tool!', role: 'main', args: {}, result: failed('boom'), endedAt: 1}).tool, 'other');
  // Stopped or declined by the member.
  assert.equal(toolFailure({tool: 'bash', role: 'main', args: {}, result: failed('managed-tool-cancelled'), endedAt: 1}), null);
  assert.equal(toolFailure({tool: 'run_with_network', role: 'main', args: {}, result: failed('managed-operation-denied'), endedAt: 1}), null);
});

test('failed calls wait for a token Studio accepts; a Studio without the log is not asked again', async () => {
  const owner = {origin: 'https://studio.example', grant: null, boundary: {engine: null}}, s = session();
  let clock = 10_000;
  trackToolFailures(owner, s, 'main', () => clock);
  s.emit({type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {command: 'make test'}});
  clock += 2000;
  s.emit({type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', isError: false, result: failed('ok')});
  assert.equal(owner.toolFailures.queue.length, 0, 'a tool that worked is not logged');
  s.emit({type: 'tool_execution_start', toolCallId: 'b', toolName: 'bash', args: {command: 'make test'}});
  clock += 3000;
  s.emit({type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', isError: true, result: failed('boom\n\nCommand exited with code 2')});
  assert.equal(owner.toolFailures.queue.length, 1, 'no token yet: it waits');

  const lapsed = studio(401);
  await sendToolFailures(owner, 'as_run_old', {fetchImpl: lapsed.fetchImpl, now: () => clock});
  assert.equal(owner.toolFailures.queue.length, 1, 'a refused token keeps it for the next request');
  const next = studio(204);
  clock += 500;
  await sendToolFailures(owner, 'as_run_new', {fetchImpl: next.fetchImpl, now: () => clock});
  assert.equal(owner.toolFailures.queue.length, 0);
  const [request] = next.requests;
  assert.equal(request.url, 'https://studio.example/studio/v1/managed/tool-failures'); assert.equal(request.token, 'Bearer as_run_new');
  assert.match(request.body.os, /^\w+ \S+ \w+$/);
  assert.deepEqual(request.body.failures.map(({id, ...rest}) => rest), [{tool: 'bash', role: 'main', code: 'exit_2', input: 'make test', error: 'boom\n\nCommand exited with code 2', duration_ms: 3000, engine: 'none', age_ms: 500}]);
  assert.equal(sendToolFailures(owner, 'as_run_new', next), null, 'nothing waiting, nothing sent');

  s.emit({type: 'tool_execution_end', toolCallId: 'c', toolName: 'read', isError: true, result: failed('ENOENT')});
  const old = studio(404);
  await sendToolFailures(owner, 'as_run_new', {fetchImpl: old.fetchImpl});
  assert.equal(owner.toolFailures.off, true);
  s.emit({type: 'tool_execution_end', toolCallId: 'd', toolName: 'read', isError: true, result: failed('ENOENT')});
  assert.equal(owner.toolFailures.queue.length, 0);
});

test('a failure Studio keeps refusing is dropped after three attempts', async () => {
  const owner = {origin: 'https://studio.example', grant: null}, s = session();
  trackToolFailures(owner, s, 'verify');
  s.emit({type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', isError: true, result: failed('boom')});
  for (let i = 0; i < 3; i++) await sendToolFailures(owner, 'as_run_x', {fetchImpl: studio(503).fetchImpl});
  assert.equal(owner.toolFailures.queue.length, 0);
});
