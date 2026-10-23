import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

// Drive the same terminal UI through the personal dashboard's CompanyRelay.
// Markers are split in commands so echoed input cannot satisfy assertions.
export async function qualifyCompanyTerminal(page, project) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'Mở terminal', exact: true }).click();
  const rows = page.locator('.xterm-rows');
  const command = async text => {
    await page.locator('.xterm-helper-textarea:visible').focus();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  };
  await command("printf 'COMPANY_%s\\n' READY; printf sandbox-write > terminal-proof.txt");
  await expect(rows).toContainText('COMPANY_READY');
  await expect.poll(() => fs.existsSync(path.join(project, 'terminal-proof.txt'))).toBe(true);
  assert.equal(fs.readFileSync(path.join(project, 'terminal-proof.txt'), 'utf8'), 'sandbox-write');
  // Linux masks it with an empty file, macOS refuses to read it.
  await command("test -z \"$(cat .env 2>/dev/null)\" && printf 'CREDENTIAL_%s\\n' MASKED");
  await expect(rows).toContainText('CREDENTIAL_MASKED');
  await command("if curl --connect-timeout 2 --max-time 3 https://example.com; then echo NETWORK_UNEXPECTED; else printf 'NETWORK_%s\\n' DENIED; fi");
  await expect(rows).toContainText('NETWORK_DENIED', { timeout: 10000 });
  await command("if (echo escape > /etc/piagent-terminal-escape); then echo WRITE_UNEXPECTED; else printf 'OUTSIDE_%s\\n' DENIED; fi");
  await expect(rows).toContainText('OUTSIDE_DENIED');
  assert.equal(fs.existsSync('/etc/piagent-terminal-escape'), false);
  await command("stty size > terminal-size.txt");
  await expect.poll(() => fs.existsSync(path.join(project, 'terminal-size.txt'))).toBe(true);
  const before = fs.readFileSync(path.join(project, 'terminal-size.txt'), 'utf8');
  await page.getByRole('separator', { name: /Chiều cao terminal|Terminal height/ }).focus();
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  await command("stty size > terminal-size.txt");
  await expect.poll(() => fs.readFileSync(path.join(project, 'terminal-size.txt'), 'utf8')).not.toBe(before);
  await command("printf 'INTERRUPT_%s\\n' READY; sleep 30");
  await expect(rows).toContainText('INTERRUPT_READY');
  await page.keyboard.press('Control+c');
  await command("printf 'INTERRUPT_%s\\n' DONE");
  await expect(rows).toContainText('INTERRUPT_DONE');
  await page.reload();
  await page.getByRole('navigation').getByText('hello company', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(rows).toContainText('INTERRUPT_DONE');
  await command("printf 'RECONNECTED_%s\\n' OK");
  await expect(rows).toContainText('RECONNECTED_OK');
  await page.getByRole('button', { name: /Đóng terminal|Close terminal/ }).click();
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mở terminal', exact: true }).click();
  const marker = `piagent-terminal-child-${Date.now()}`;
  await command(`bash -c 'exec -a ${marker} sleep 300' &`);
  // ps works on both platforms; `exec -a` names the process after the marker.
  const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/)).map(([pid, stat, command]) => ({ pid, stat, command }));
  const childPids = () => processes().filter(item => item.command === marker && !item.stat.startsWith('Z')).map(item => item.pid);
  await expect.poll(childPids).toHaveLength(1);
  const [pid] = childPids();
  const receipt = await page.evaluate(async () => {
    const catalog = await (await fetch('/api/v1/session-catalog')).json();
    const session = catalog.sessions.find(item => item.title === 'hello company');
    if (!session) throw Error('company session missing');
    const now = new Date(), command = {
      schemaVersion: 1, version: 'piagent-session-command-v1', messageType: 'command',
      commandId: `command.${crypto.randomUUID()}`, idempotencyKey: `idempotency_${crypto.randomUUID()}`,
      action: 'session.release', requestedAt: now.toISOString(), expiresAt: new Date(+now + 60000).toISOString(),
      sessionRef: session.sessionRef, expectedCatalogRevision: catalog.catalogRevision,
      expectedSessionRevision: session.sessionRevision, payload: {},
    };
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/api/v1/gateway`, 'piagent.gateway.v1');
      const timer = setTimeout(() => { socket.close(); reject(Error('release timeout')); }, 15000);
      socket.onopen = () => socket.send(JSON.stringify({ schemaVersion: 1, version: 'piagent-gateway-protocol-v1',
        messageType: 'connect', clientRef: 'client.terminalqualification', minimumProtocol: 1, maximumProtocol: 1,
        lastEventSequence: null, catalogRevision: null }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.messageType === 'hello') socket.send(JSON.stringify({ schemaVersion: 1,
          version: 'piagent-gateway-protocol-v1', messageType: 'request', requestId: 'request_terminalrelease',
          method: 'sessions.command', params: { command } }));
        if (message.requestId === 'request_terminalrelease') {
          clearTimeout(timer); socket.close(); resolve(message);
        }
      };
      socket.onclose = event => { clearTimeout(timer); reject(Error(`release socket closed: ${event.code} ${event.reason}`)); };
      socket.onerror = () => { clearTimeout(timer); socket.close(); reject(Error('release socket failed')); };
    });
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.result.phase, 'settled', JSON.stringify(receipt));
  await expect.poll(() => !childPids().includes(pid)).toBe(true);
}
