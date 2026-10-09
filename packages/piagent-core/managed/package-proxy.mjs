import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { lookup } from 'node:dns/promises';

// The package registries a company command reaches without asking: plain
// bash has no network, except through this proxy, which the trusted runtime
// runs outside the sandbox. It tunnels HTTPS (CONNECT) and forwards plain
// HTTP to the hosts below and the member's own additions, on ports 443 and
// 80 only, never to an IP literal or a name that resolves to this machine or
// a private network (DNS rebinding), and connects to the address it checked.
// Everything else is refused with 403 and remembered, so the command's
// failure names the host and run_with_network (the member approves it).
// Registries (and GitHub) take no upload without a token, and tokens stay
// out of the sandbox (.npmrc, ~/.m2/settings.xml, git credentials).
export const DEFAULT_DOMAINS = Object.freeze([
  // JavaScript
  'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'registry.npmmirror.com', 'jsr.io', 'npm.jsr.io', 'deno.land',
  // Python
  'pypi.org', 'files.pythonhosted.org',
  // Go
  'proxy.golang.org', 'sum.golang.org', 'index.golang.org',
  // Rust
  'crates.io', 'index.crates.io', 'static.crates.io', 'static.rust-lang.org',
  // JVM
  'repo.maven.apache.org', 'repo1.maven.org', 'maven.google.com', 'dl.google.com', 'plugins.gradle.org', 'plugins-artifacts.gradle.org',
  'services.gradle.org', 'downloads.gradle.org', 'repo.spring.io', 'jitpack.io',
  // .NET, Ruby, PHP, Dart, Swift/CocoaPods, Elixir
  'api.nuget.org', 'globalcdn.nuget.org', 'rubygems.org', 'index.rubygems.org', 'packagist.org', 'repo.packagist.org',
  'pub.dev', 'cdn.cocoapods.org', 'repo.hex.pm', 'builds.hex.pm',
  // Public GitHub downloads: release assets (the Gradle Wrapper's
  // distributions redirect there), git dependencies and archives. Nothing
  // is pushed or uploaded without a token, and none reaches the sandbox.
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
]);
const PORTS = new Set([80, 443]);

// One host name per line in the member's file (# comments); "*.example.com"
// covers its subdomains. Read by the trusted runtime: the sandbox cannot.
export function memberDomains(userHome, file = path.join(userHome, '.piagent/sandbox-domains')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').map(line => line.replace(/#.*/, '').trim().toLowerCase()).filter(name => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)).slice(0, 200);
}

export function domainAllowed(host, domains) {
  const name = String(host).toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(name) || net.isIP(name)) return false;
  return domains.some(rule => rule.startsWith('*.') ? name.endsWith(rule.slice(1)) && name.length > rule.length - 1 : name === rule);
}

// Addresses that are this machine, a private network or not routable.
export function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

function upstreamProxy(env) {
  for (const name of ['HTTPS_PROXY', 'https_proxy']) {
    try { const url = new URL(env[name]); if (url.protocol === 'http:' && url.hostname && !url.username) return { host: url.hostname, port: Number(url.port) || 80 }; } catch { /* unset */ }
  }
  return null;
}

export class PackageProxy {
  #server; #sockets = new Set();
  // (`ports` and `isPrivate` are for tests.)
  constructor({ domains = DEFAULT_DOMAINS, resolve = name => lookup(name, { all: true }), env = process.env, maxDenied = 200, ports = PORTS, isPrivate = privateAddress } = {}) {
    this.domains = [...new Set(domains.map(name => name.toLowerCase()))];
    this.resolve = resolve; this.upstream = upstreamProxy(env); this.maxDenied = maxDenied; this.ports = new Set(ports); this.isPrivate = isPrivate;
    this.log = []; this.deniedCount = 0;
    this.#server = http.createServer((request, response) => this.#forward(request, response));
    this.#server.on('connect', (request, socket, head) => this.#tunnel(request, socket, head));
    this.#server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
    this.#server.on('clientError', (_error, socket) => socket.destroy());
  }
  // A TCP port on loopback (macOS) or a Unix socket (Linux).
  listen(where) {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      const done = () => { this.#server.off('error', reject); resolve(this.#server.address()); };
      if (typeof where === 'string') this.#server.listen(where, done); else this.#server.listen(0, '127.0.0.1', done);
    });
  }
  #deny(host) {
    this.deniedCount += 1;
    this.log.push(String(host).slice(0, 253)); if (this.log.length > this.maxDenied) this.log.shift();
  }
  // The hosts refused since the count was `before` (at most the last few).
  deniedSince(before) {
    const count = Math.min(this.deniedCount - before, this.log.length);
    return count > 0 ? [...new Set(this.log.slice(-count))].slice(-5) : [];
  }
  // The checked public address of an allowed host, or null.
  async #target(host, port) {
    if (!this.ports.has(port) || !domainAllowed(host, this.domains)) { this.#deny(host); return null; }
    if (this.upstream) return { host, port };
    try {
      const addresses = await this.resolve(host);
      if (!addresses.length || addresses.some(entry => this.isPrivate(entry.address))) { this.#deny(host); return null; }
      return { host: addresses[0].address, port };
    } catch { this.#deny(host); return null; }
  }
  async #tunnel(request, socket, head) {
    socket.on('error', () => {});
    const match = /^([^:[\]]+|\[[^\]]+\]):(\d+)$/.exec(request.url ?? '');
    const target = match ? await this.#target(match[1], Number(match[2])) : (this.#deny(request.url ?? ''), null);
    if (!target) { socket.end('HTTP/1.1 403 Forbidden\r\nX-Piagent-Proxy: domain-not-allowed\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = this.upstream ? net.connect(this.upstream.port, this.upstream.host) : net.connect(target.port, target.host);
    upstream.setTimeout(10 * 60_000, () => upstream.destroy());
    upstream.once('connect', () => {
      if (this.upstream) {
        upstream.write(`CONNECT ${match[1]}:${match[2]} HTTP/1.1\r\nHost: ${match[1]}:${match[2]}\r\n\r\n`);
        let reply = Buffer.alloc(0);
        const onData = chunk => {
          reply = Buffer.concat([reply, chunk]);
          const end = reply.indexOf('\r\n\r\n'); if (end < 0) { if (reply.length > 16384) upstream.destroy(); return; }
          upstream.off('data', onData);
          if (!/^HTTP\/1\.[01] 2\d\d/.test(reply.subarray(0, end).toString('latin1'))) { socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); upstream.destroy(); return; }
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (reply.length > end + 4) socket.write(reply.subarray(end + 4)); if (head?.length) upstream.write(head);
          upstream.pipe(socket); socket.pipe(upstream);
        };
        upstream.on('data', onData);
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => { if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    socket.on('close', () => upstream.destroy());
  }
  async #forward(request, response) {
    let url;
    try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (url.protocol !== 'http:') { response.writeHead(400).end(); return; }
    const target = await this.#target(url.hostname, Number(url.port) || 80);
    if (!target) { response.writeHead(403, { 'X-Piagent-Proxy': 'domain-not-allowed', 'Content-Type': 'text/plain; charset=utf-8' }).end(`piagent: ${url.hostname} is not an allowed package registry\n`); return; }
    const headers = { ...request.headers, host: url.host }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const outgoing = http.request(this.upstream
      ? { host: this.upstream.host, port: this.upstream.port, path: url.href, method: request.method, headers }
      : { host: target.host, port: target.port, path: url.pathname + url.search, method: request.method, headers, servername: url.hostname }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(outgoing);
  }
  async close() {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise(resolve => this.#server.close(() => resolve()));
  }
}

// Maven reads its proxy only from settings.xml (not the JVM's properties):
// a settings file in the sandbox's own home, which Maven reads as the user's
// once MAVEN_OPTS names that home (Java takes user.home from the account,
// not from HOME, and the member's ~/.m2 is closed here).
export function mavenSettings(url) {
  const { hostname, port } = new URL(url);
  const proxy = protocol => `<proxy><id>piagent-${protocol}</id><active>true</active><protocol>${protocol}</protocol><host>${hostname}</host><port>${port}</port><nonProxyHosts>localhost|127.0.0.1</nonProxyHosts></proxy>`;
  return `<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"><proxies>${proxy('https')}${proxy('http')}</proxies></settings>\n`;
}

// Environment a command gets for the proxy at this URL: the variables
// package managers read, and the JVM's (Gradle), which ignores them.
export function proxyEnvironment(url, { mavenOpts = '', gradleOpts = '', mavenHome = null } = {}) {
  const { hostname, port } = new URL(url);
  const jvm = `-Dhttp.proxyHost=${hostname} -Dhttp.proxyPort=${port} -Dhttps.proxyHost=${hostname} -Dhttps.proxyPort=${port} -Dhttp.nonProxyHosts=localhost|127.0.0.1|::1`;
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    npm_config_proxy: url, npm_config_https_proxy: url,
    MAVEN_OPTS: [mavenOpts, jvm, mavenHome && `-Duser.home=${mavenHome}`].filter(Boolean).join(' '), GRADLE_OPTS: [gradleOpts, jvm].filter(Boolean).join(' '),
  };
}
