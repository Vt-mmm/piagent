import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {WebSocketServer} from 'ws';
import '../scripts/register-typescript-loader.mjs';
import {CompanyRelay} from '../packages/piagent-webui/gateway/company-relay.ts';

// Found live on Windows/WSL: the dashboard opened and kept loading. Its
// catalog, live state and new-chat options each waited, without a limit, for
// a company Gateway that had taken the connection and signed the relay in but
// answered no read. A company Gateway as the relay meets it: a control socket,
// the sign-in, the WebSocket hello, and reads answered only while `answering`.
async function companyGateway(answering) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-timeout-')), socketPath = path.join(dir, 'control.sock'), held = new Set();
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v1/bootstrap') {
      response.writeHead(200, {'Content-Type': 'application/json', 'Set-Cookie': 'piagent_webui_session=fixture; HttpOnly'});
      response.end(JSON.stringify({authenticated: true, csrfToken: 'c'.repeat(43)})); return;
    }
    if (!answering(request.url)) { held.add(response); return; }
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(request.url === '/api/v1/session-catalog'
      ? {state: 'ready', catalogRevision: 'rev_company', sessions: [], page: {total: 0, returned: 0}} : {operations: []}));
  });
  const sockets = new WebSocketServer({server});
  sockets.on('connection', (socket) => socket.on('message', () => socket.send(JSON.stringify({messageType: 'hello'}))));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const control = net.createServer((socket) => socket.on('data', (chunk) => {
    const action = JSON.parse(String(chunk)).action;
    socket.end(JSON.stringify({ok: true, value: action === 'project.paths' ? [] : {launchUrl: `${origin}/#bootstrap=${'b'.repeat(43)}`}}) + '\n');
  }));
  await new Promise((resolve) => control.listen(socketPath, resolve));
  return {socketPath, close: async () => {
    for (const response of held) response.destroy();
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections(); await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => control.close(resolve))]);
    fs.rmSync(dir, {recursive: true, force: true});
  }};
}

const relayFor = (socketPath, published = []) => new CompanyRelay({
  connector: {configured: () => true, ensure: async () => socketPath, attach: async () => socketPath},
  events: {publish: (kind, payload) => published.push({kind, payload})},
  hubProject: (cwd) => cwd, folder: async () => null, readTimeoutMs: 300, answerTimeoutMs: 300,
});
const within = async (ms, work) => { const started = Date.now(), value = await work(); assert.ok(Date.now() - started < ms, `took ${Date.now() - started} ms`); return value; };

test('a company Gateway that never answers a read is not "ready", and the dashboard reads do not wait for it', {timeout: 20000}, async () => {
  const gateway = await companyGateway(() => false), relay = relayFor(gateway.socketPath);
  try {
    await within(2000, () => relay.connect(false));
    assert.deepEqual([relay.status().state, relay.status().reasonCode], ['unavailable', 'company-gateway-timeout']);
    assert.equal(await within(200, () => relay.catalog()), null);
    assert.deepEqual(await within(200, () => relay.operations()), []);
    assert.deepEqual(await within(200, () => relay.models()), []);
  } finally { relay.close(); await gateway.close(); }
});

test('a company Gateway that stops answering costs one bounded wait, then its rows are left out', {timeout: 20000}, async () => {
  let reads = true;
  const published = [], gateway = await companyGateway(() => reads), relay = relayFor(gateway.socketPath, published);
  const personal = {state: 'ready', catalogRevision: 'rev_personal', sessions: [], page: {total: 0, returned: 0}};
  try {
    await relay.connect(false);
    assert.equal(relay.status().state, 'ready');
    assert.equal((await relay.catalog()).catalogRevision, 'rev_company');
    reads = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await within(2000, () => relay.operations()), [], 'the live state is served without the company operations');
    assert.deepEqual([relay.status().state, relay.status().reasonCode], ['unavailable', 'company-gateway-timeout']);
    assert.equal((await within(200, () => relay.merge(personal))).state, 'ready', 'the personal catalog is still served');
    assert.ok(published.some((event) => event.payload.reasonCode === 'company-unavailable'));
    // Every later read answers at once: the stalled Gateway is not asked again by each of them.
    assert.deepEqual(await within(200, () => relay.operations()), []);
    assert.equal((await within(200, () => relay.merge(personal))).state, 'ready');
    await assert.rejects(within(200, () => relay.http('GET', '/api/v1/sessions/x/inspection/transcript')), /company-gateway-timeout|company-unavailable/);
  } finally { relay.close(); await gateway.close(); }
});
