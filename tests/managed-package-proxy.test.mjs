import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_DOMAINS, PackageProxy, domainAllowed, mavenSettings, memberDomains, privateAddress, proxyEnvironment } from '../packages/piagent-core/managed/package-proxy.mjs';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-proxy-')));
const closers = [];
after(async () => { for (const close of closers.reverse()) await close(); fs.rmSync(base, { recursive: true, force: true }); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { closers.push(() => new Promise(r => server.close(() => r()))); resolve(server.address().port); }));

// CONNECT through the proxy; resolves with the status line and, when the
// tunnel opened, what the target sent back.
function connect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (/^HTTP\/1\.1 200/.test(data) && data.includes('\r\n\r\n') && !socket.sentPing) { socket.sentPing = true; socket.write('ping'); }
      if (/ECHO:ping/.test(data) || /^HTTP\/1\.1 (403|502)/.test(data)) { socket.destroy(); resolve(data); }
    });
    socket.on('error', reject); socket.setTimeout(3000, () => { socket.destroy(); resolve(data); });
  });
}

test('host rules: exact names and *.subdomains, never IP literals; member additions read from their file', () => {
  const rules = ['registry.npmjs.org', '*.example.com'];
  assert.ok(domainAllowed('registry.npmjs.org', rules));
  assert.ok(domainAllowed('REGISTRY.npmjs.org.', rules));
  assert.ok(domainAllowed('a.b.example.com', rules));
  assert.equal(domainAllowed('example.com', rules), false, '*.example.com is subdomains only');
  assert.equal(domainAllowed('evil-registry.npmjs.org.attacker.net', rules), false);
  assert.equal(domainAllowed('notexample.com', rules), false);
  assert.equal(domainAllowed('127.0.0.1', ['127.0.0.1']), false);
  const defaults = new Set(DEFAULT_DOMAINS);
  assert.ok(defaults.has('registry.npmjs.org') && defaults.has('repo.maven.apache.org') && defaults.has('github.com') && !defaults.has('gist.github.com') && !defaults.has('api.github.com'));
  const home = path.join(base, 'member');
  fs.mkdirSync(path.join(home, '.piagent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.piagent/sandbox-domains'), '# company mirror\nnexus.company.vn\n*.jfrog.io  # artifacts\nnot a host\nhttp://x.y\n');
  assert.deepEqual(memberDomains(home), ['nexus.company.vn', '*.jfrog.io']);
  assert.deepEqual(memberDomains(path.join(base, 'nobody')), []);
});

test('private and local addresses are recognised', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.129', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.ok(privateAddress(address), address);
  for (const address of ['104.16.0.35', '8.8.8.8', '2606:4700::6810:84e5', '172.32.0.1'])
    assert.equal(privateAddress(address), false, address);
});

test('the proxy tunnels to allowed hosts only, at the address it checked, and remembers refusals', async () => {
  const echo = net.createServer(socket => socket.on('data', chunk => socket.write(`ECHO:${chunk}`)));
  const echoPort = await listen(echo);
  const resolved = [];
  const proxy = new PackageProxy({ domains: ['registry.npmjs.org', 'rebind.example'], ports: [echoPort], isPrivate: address => address === '10.0.0.5',
    resolve: async name => { resolved.push(name); return [{ address: name === 'rebind.example' ? '10.0.0.5' : '127.0.0.1' }]; } });
  closers.push(() => proxy.close());
  const { port } = await proxy.listen();
  assert.match(await connect(port, `registry.npmjs.org:${echoPort}`), /^HTTP\/1\.1 200[\s\S]*ECHO:ping/);
  const before = proxy.deniedCount;
  assert.match(await connect(port, `example.com:${echoPort}`), /^HTTP\/1\.1 403/);
  assert.match(await connect(port, `rebind.example:${echoPort}`), /^HTTP\/1\.1 403/, 'a name that resolves to a private address');
  assert.match(await connect(port, `127.0.0.1:${echoPort}`), /^HTTP\/1\.1 403/);
  assert.match(await connect(port, 'registry.npmjs.org:22'), /^HTTP\/1\.1 403/, 'only the registry ports');
  assert.deepEqual(proxy.deniedSince(before), ['example.com', 'rebind.example', '127.0.0.1', 'registry.npmjs.org']);
  assert.deepEqual(proxy.deniedSince(proxy.deniedCount), []);
  assert.deepEqual(resolved, ['registry.npmjs.org', 'rebind.example'], 'a refused name is never looked up');
});

test('plain HTTP is forwarded to allowed hosts with the Host header kept', async () => {
  const origin = http.createServer((request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: request.method, path: request.url, host: request.headers.host })));
  const originPort = await listen(origin);
  const proxy = new PackageProxy({ domains: ['repo.example'], ports: [originPort], isPrivate: () => false, resolve: async () => [{ address: '127.0.0.1' }] });
  closers.push(() => proxy.close());
  const { port } = await proxy.listen();
  const get = url => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url).host } }, response => {
    let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
  }).on('error', reject));
  const forwarded = await get(`http://repo.example:${originPort}/maven2/x.pom?y=1`);
  assert.equal(forwarded.status, 200);
  assert.deepEqual(JSON.parse(forwarded.body), { method: 'GET', path: '/maven2/x.pom?y=1', host: `repo.example:${originPort}` });
  const refused = await get(`http://other.example:${originPort}/`);
  assert.equal(refused.status, 403);
  assert.match(refused.body, /other\.example is not an allowed package registry/);
});

test('commands get the proxy in the variables package managers and the JVM read', () => {
  const env = proxyEnvironment('http://127.0.0.1:41234', { mavenOpts: '-Dmaven.repo.local=/c/m2' });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:41234');
  assert.equal(env.npm_config_https_proxy, 'http://127.0.0.1:41234');
  assert.match(env.NO_PROXY, /localhost,127\.0\.0\.1/);
  assert.match(env.MAVEN_OPTS, /^-Dmaven\.repo\.local=\/c\/m2 -Dhttp\.proxyHost=127\.0\.0\.1 -Dhttp\.proxyPort=41234 -Dhttps\.proxyHost=127\.0\.0\.1 -Dhttps\.proxyPort=41234/);
  assert.match(env.GRADLE_OPTS, /^-Dhttp\.proxyHost=127\.0\.0\.1/);
  assert.doesNotMatch(env.MAVEN_OPTS, /user\.home/);
  assert.match(proxyEnvironment('http://127.0.0.1:41234', { mavenHome: '/h' }).MAVEN_OPTS, / -Duser\.home=\/h$/);
  assert.match(mavenSettings('http://127.0.0.1:41234'), /<protocol>https<\/protocol><host>127\.0\.0\.1<\/host><port>41234<\/port>/);
});

// The real sandbox: a plain command reaches an allowed registry through the
// proxy, is refused another host with its name in the failure, and still
// reaches it while a local proxy closes the rest of loopback (macOS).
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const online = process.env.PIAGENT_TEST_ONLINE === '1' || (!process.env.CI && fs.existsSync(path.join(sdkRoot, 'dist/index.js')));
test('a plain command installs from a registry without approval and is refused other hosts', { skip: process.platform !== 'darwin' || !online, timeout: 120000 }, async () => {
  const cwd = path.join(base, 'shop'); fs.mkdirSync(cwd, { recursive: true });
  const localProxy = net.createServer(socket => socket.destroy());
  const localPort = await listen(localProxy);
  for (const proxyPorts of [[], [localPort]]) {
    const boundary = new ManagedToolBoundary({ cwd, sdkRoot, identity: null, proxyPorts });
    try {
      const text = result => result.content.map(part => part.text).join('');
      assert.equal(text(await boundary.invoke('bash', { command: 'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/left-pad', timeout: 30 })).trim(), '200', `registry reached (local proxy: ${proxyPorts.length > 0})`);
      await assert.rejects(boundary.invoke('bash', { command: 'curl -sS -m 20 https://example.com/ -o /dev/null', timeout: 30 }), /^Error: managed-domain-blocked: .*Host bị chặn: example\.com\. .*run_with_network/s);
      await assert.rejects(boundary.invoke('bash', { command: 'curl -sS -m 5 --noproxy "*" https://registry.npmjs.org/ -o /dev/null', timeout: 30 }), /managed-network-blocked|Could not resolve|not permitted/, 'nothing goes around the proxy');
    } finally { await boundary.dispose(); }
  }
});

test('a read-only helper has no proxy', { skip: process.platform !== 'darwin' || !fs.existsSync(path.join(sdkRoot, 'dist/index.js')) }, async () => {
  const cwd = path.join(base, 'shop'); fs.mkdirSync(cwd, { recursive: true });
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot, identity: null, readOnly: true, commands: true });
  try { assert.equal(boundary.proxy, undefined); assert.equal(boundary.environment.offline.HTTPS_PROXY, undefined); }
  finally { await boundary.dispose(); }
});
