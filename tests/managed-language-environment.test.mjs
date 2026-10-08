import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {languageEnvironment} from '../packages/piagent-core/managed/language-environment.mjs';
import {ManagedToolBoundary} from '../packages/piagent-core/managed/tool-boundary.mjs';

// What tests of the common languages need in the company sandbox: package
// caches kept per project, the member's caches as read-only seeds, runtimes
// installed under ~/Library, SwiftPM and xcodebuild without their own
// sandbox, and servers on this Mac (a test's own server, a local database)
// unless a local proxy would carry a command to the internet.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const text = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('');
const write = (file, value = 'x\n') => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value); };
// Where caches, the Android SDK and pnpm's settings live on this platform.
const macos = process.platform === 'darwin';
const CACHE_ROOT = macos ? 'Library/Caches/Piagent/sandbox' : '.cache/piagent/sandbox';
const ANDROID = macos ? 'Library/Android/sdk' : 'Android/Sdk';
const PNPM_RC = macos ? 'Library/Preferences/pnpm/rc' : '.config/pnpm/rc';
delete process.env.XDG_CACHE_HOME;

function machine() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-languages-')));
  const home = path.join(base, 'home'), project = path.join(base, 'shop'), sandboxHome = path.join(base, 'sandbox-home');
  for (const file of ['.gradle/caches/modules-2/files-2.1/x.jar', '.m2/repository/org/x/x.pom', '.m2/settings.xml',
    '.m2/wrapper/dists/apache-maven-3.9.14/db91789b/bin/mvn', '.gradle/wrapper/dists/gradle-8.10-bin/abc123/gradle-8.10/bin/gradle', '.gradle/wrapper/dists/gradle-8.10-bin/abc123/gradle-8.10-bin.zip.ok',
    '.gradle/wrapper/dists/gradle-8.10-bin/abc123/gradle-8.10-bin.zip', '.gradle/wrapper/dists/gradle-8.11-bin/def456/gradle-8.11-bin.zip.part', '.nuget/packages/newtonsoft.json/13.0.3/x.nupkg',
    'go/pkg/mod/cache/download/example.com/x/@v/list', 'Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/release', `${ANDROID}/platforms/x`]) write(path.join(home, file));
  fs.mkdirSync(project); fs.mkdirSync(sandboxHome);
  return {base, home, project, sandboxHome};
}

test('package caches persist per project; the member\'s caches are read-only seeds; tools write nowhere else', () => {
  const {base, home, project, sandboxHome} = machine();
  try {
    const env = languageEnvironment({userHome: home, repositoryTop: project, home: sandboxHome});
    assert.ok(env.cache.startsWith(path.join(home, CACHE_ROOT) + '/'), env.cache);
    assert.equal(fs.statSync(env.cache).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(sandboxHome, PNPM_RC), 'utf8'), `store-dir=${env.cache}/pnpm-store\n`);
    assert.deepEqual(languageEnvironment({userHome: home, repositoryTop: project, home: sandboxHome}).cache, env.cache, 'the same project keeps its cache');
    assert.notEqual(languageEnvironment({userHome: home, repositoryTop: path.join(base, 'other'), home: sandboxHome}).cache, env.cache, 'another project has its own');
    for (const [name, value] of Object.entries(env.env.offline)) {
      if (/^(npm_config_cache|YARN_CACHE_FOLDER|PIP_CACHE_DIR|UV_CACHE_DIR|GOMODCACHE|GOCACHE|CARGO_HOME|GRADLE_USER_HOME|NUGET_PACKAGES|PUB_CACHE|GEM_HOME|BUNDLE_PATH)$/.test(name))
        assert.ok(value.startsWith(env.cache), `${name} is in the project cache`);
    }
    assert.equal(env.env.offline.GRADLE_RO_DEP_CACHE, path.join(home, '.gradle/caches'));
    assert.equal(env.env.offline.NUGET_FALLBACK_PACKAGES, path.join(home, '.nuget/packages'));
    assert.match(env.env.offline.MAVEN_OPTS, new RegExp(`-Dmaven\\.repo\\.local=${env.cache}/m2/repository -Dmaven\\.repo\\.local\\.tail=${path.join(home, '.m2/repository')}`));
    // ./mvnw finds the distribution the member already unpacked, read-only, through the project's cache.
    assert.equal(env.env.offline.MAVEN_USER_HOME, path.join(env.cache, 'm2'));
    const dist = path.join(env.cache, 'm2/wrapper/dists/apache-maven-3.9.14/db91789b');
    assert.equal(fs.readlinkSync(dist), path.join(home, '.m2/wrapper/dists/apache-maven-3.9.14/db91789b'));
    assert.ok(env.readRoots.includes(path.join(home, '.m2/wrapper/dists')));
    languageEnvironment({userHome: home, repositoryTop: project, home: sandboxHome});
    assert.equal(fs.readlinkSync(dist), path.join(home, '.m2/wrapper/dists/apache-maven-3.9.14/db91789b'), 'a link already there is kept');
    // ./gradlew: its own folder per distribution (the wrapper locks a file
    // there), the marker copied and the unpacked distribution linked; one
    // still downloading is left out.
    const gradle = path.join(env.cache, 'gradle/wrapper/dists/gradle-8.10-bin/abc123');
    assert.ok(fs.lstatSync(gradle).isDirectory());
    assert.equal(fs.readlinkSync(path.join(gradle, 'gradle-8.10')), path.join(home, '.gradle/wrapper/dists/gradle-8.10-bin/abc123/gradle-8.10'));
    assert.ok(fs.lstatSync(path.join(gradle, 'gradle-8.10-bin.zip.ok')).isFile());
    assert.equal(fs.existsSync(path.join(gradle, 'gradle-8.10-bin.zip')), false, 'the downloaded archive is not needed');
    assert.equal(fs.existsSync(path.join(env.cache, 'gradle/wrapper/dists/gradle-8.11-bin/def456')), false);
    assert.ok(env.readRoots.includes(path.join(home, '.gradle/wrapper/dists')));
    assert.equal(env.env.offline.GOPROXY, `file://${path.join(home, 'go/pkg/mod/cache/download')},off`, 'offline Go reads the member\'s modules, never the internet');
    assert.match(env.env.network.GOPROXY, /^file:\/\/.+,https:\/\/proxy\.golang\.org,direct$|^file:\/\/.+,.+/);
    assert.equal(env.env.offline.ANDROID_HOME, path.join(home, ANDROID));
    for (const root of [path.join(home, '.m2/repository'), path.join(home, '.gradle/caches'), ...(macos ? [path.join(home, 'Library/Java/JavaVirtualMachines')] : [])])
      assert.ok(env.readRoots.includes(root), `${root} is readable`);
    assert.ok(!env.readRoots.some((root) => root === path.join(home, '.m2') || root === path.join(home, '.gradle')), 'their settings and credentials are not');
    // A cache unused for a month is removed; this project's is kept.
    const stale = path.join(home, CACHE_ROOT, 'stale'); fs.mkdirSync(stale);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); fs.utimesSync(stale, old, old);
    languageEnvironment({userHome: home, repositoryTop: project, home: sandboxHome});
    assert.equal(fs.existsSync(stale), false); assert.equal(fs.existsSync(env.cache), true);
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('swift and xcodebuild run without their own sandbox; build products go to the project cache', {skip: !macos}, () => {
  const {base, home, project, sandboxHome} = machine();
  try {
    const env = languageEnvironment({userHome: home, repositoryTop: project, home: sandboxHome});
    const real = path.join(base, 'real-bin'); fs.mkdirSync(real);
    for (const name of ['swift', 'xcodebuild']) fs.writeFileSync(path.join(real, name), '#!/bin/sh\necho "$(basename "$0") $*"\n', {mode: 0o755});
    const run = (name, ...args) => execFileSync(path.join(env.bin, name), args, {encoding: 'utf8', env: {PATH: `${env.bin}:${real}:/usr/bin:/bin`, PIAGENT_DERIVED_DATA: '/cache/DerivedData'}}).trim();
    assert.equal(run('swift', 'test', '--parallel'), 'swift test --disable-sandbox --parallel');
    assert.equal(run('swift', 'package', 'resolve'), 'swift package --disable-sandbox resolve');
    assert.equal(run('swift', '--version'), 'swift --version');
    assert.equal(run('xcodebuild', '-scheme', 'App', 'test'), 'xcodebuild -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES -derivedDataPath /cache/DerivedData -scheme App test');
    assert.equal(run('xcodebuild', '-list'), 'xcodebuild -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES -list');
    assert.equal(run('xcodebuild', '-scheme', 'App', '-derivedDataPath', 'dd'), 'xcodebuild -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES -scheme App -derivedDataPath dd');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('tests reach servers on this Mac unless a local proxy listens; caches outlive the conversation', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 120000}, async () => {
  const {base, home, project} = machine();
  const proxy = net.createServer((socket) => { socket.on('error', () => {}); socket.end('PROXY'); });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(project, 'server.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; import http from 'node:http';\n"
    + "test('own server', async () => { const s = http.createServer((q, r) => r.end('ok')); await new Promise((r) => s.listen(0, '127.0.0.1', r));\n"
    + "  try { assert.equal(await (await fetch(`http://127.0.0.1:${s.address().port}/`)).text(), 'ok'); } finally { s.close(); } });\n");
  const open = new ManagedToolBoundary({cwd: project, sdkRoot, protectedRoots: [], userHome: home, proxyPorts: []});
  const guarded = new ManagedToolBoundary({cwd: project, sdkRoot, protectedRoots: [], userHome: home, proxyPorts: [proxy.address().port]});
  try {
    assert.match(text(await open.invoke('bash', {command: 'node --test server.test.mjs'})), /pass 1/);
    await assert.rejects(guarded.invoke('bash', {command: 'node --test server.test.mjs'}), /managed-loopback-blocked/);
    await assert.rejects(guarded.invoke('bash', {command: `node -e "require('net').connect(${proxy.address().port}, '127.0.0.1').on('data', (d) => console.log(String(d))).on('error', (e) => { console.error('connect', e.code); process.exit(1); })"`}),
      /managed-loopback-blocked/, 'the proxy itself is out of reach');
    assert.match(text(await guarded.invoke('bash', {command: 'node --test server.test.mjs'}, undefined, undefined, undefined, {network: true})), /pass 1/, 'an approved command reaches it');
    // The project's package cache: written in one conversation, read in the next.
    await open.invoke('bash', {command: 'mkdir -p "$npm_config_cache" && echo kept > "$npm_config_cache/marker"'});
    const next = new ManagedToolBoundary({cwd: project, sdkRoot, protectedRoots: [], userHome: home, proxyPorts: []});
    try { assert.equal(text(await next.invoke('bash', {command: 'cat "$npm_config_cache/marker"'})).trim(), 'kept'); } finally { await next.dispose(); }
    // Seeds are read, never written; settings beside them stay closed.
    assert.match(text(await open.invoke('bash', {command: `ls ${JSON.stringify(path.join(home, '.m2/repository/org/x'))}`})), /x\.pom/);
    await assert.rejects(open.invoke('bash', {command: `echo y > ${JSON.stringify(path.join(home, '.m2/repository/org/x/y.pom'))}`}), /not permitted|managed-sandbox-denied/);
    await assert.rejects(open.invoke('bash', {command: `cat ${JSON.stringify(path.join(home, '.m2/settings.xml'))}`}), /not permitted|managed-sandbox-denied/);
    // ./mvnw's distribution: read without network through the project cache, never written.
    assert.equal(text(await open.invoke('bash', {command: 'cat "$MAVEN_USER_HOME/wrapper/dists/apache-maven-3.9.14/db91789b/bin/mvn"'})).trim(), 'x');
    await assert.rejects(open.invoke('bash', {command: 'echo y > "$MAVEN_USER_HOME/wrapper/dists/apache-maven-3.9.14/db91789b/bin/mvn"'}), /not permitted|managed-sandbox-denied/);
  } finally { await open.dispose(); await guarded.dispose(); await new Promise((resolve) => proxy.close(resolve)); fs.rmSync(base, {recursive: true, force: true}); }
});
