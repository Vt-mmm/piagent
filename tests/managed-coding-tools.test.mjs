import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {ManagedToolBoundary} from '../packages/piagent-core/managed/tool-boundary.mjs';
import {fetchPublicPage, htmlToText, pinnedLookup, privateAddress} from '../packages/piagent-core/managed/web-fetch.mjs';
import {searchResultText, searchThroughPool, searchThroughStudio} from '../packages/piagent-core/managed/web-search.mjs';
import {projectInstructions} from '../packages/piagent-core/managed/resource-loader.mjs';
import {fallbackFind, fallbackGrep, globToRegExp} from '../packages/piagent-core/managed/search-fallback.mjs';
import net from 'node:net';

// Coding-agent work inside the company sandbox, without provider or internet
// traffic: code search, commits, monorepos, network only after approval, web
// page reads limited to public addresses, and search through Studio.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const searchTools = ['rg', 'fd'].every((name) => [path.join(os.homedir(), '.pi/agent/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].some((file) => fs.existsSync(file)));
const text = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('');

function repository() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-coding-')));
  const repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'packages/api/src'), {recursive: true});
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"shop","private":true}\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Shop\nRun the tests before committing.\n');
  fs.writeFileSync(path.join(repo, 'packages/api/AGENTS.md'), '# API\nKeep handlers pure.\n');
  fs.writeFileSync(path.join(repo, 'packages/api/src/cart.js'), 'export const total = (items) => items.length;\n');
  fs.writeFileSync(path.join(repo, 'packages/api/.npmrc'), '//registry.example/:_authToken=secret\n');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'init']);
  return {base, repo, api: path.join(repo, 'packages/api')};
}

test('coding work in the sandbox: search, commit in a monorepo package, network only when approved', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot)}, async () => {
  const {base, repo, api} = repository();
  const server = http.createServer((_req, res) => res.end('local-ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const boundary = new ManagedToolBoundary({cwd: api, sdkRoot, protectedRoots: [], identity: {name: 'Company Dev', email: 'dev@example.com'}, proxyPorts: []});
  try {
    if (searchTools) {
      assert.match(text(await boundary.invoke('grep', {pattern: 'total'})), /src\/cart\.js:1/);
      assert.match(text(await boundary.invoke('find', {pattern: '*.js'})), /src\/cart\.js/);
    }
    // The package sits in a larger repository: git works and the root is readable.
    assert.match(text(await boundary.invoke('read', {path: '../../package.json'})), /"name":"shop"/);
    await boundary.invoke('edit', {path: 'src/cart.js', edits: [{oldText: 'items.length', newText: 'items.reduce((sum, item) => sum + item.price, 0)'}]});
    const commit = text(await boundary.invoke('bash', {command: 'git add src/cart.js && git commit -qm "Sum prices" && git log -1 --format="%an <%ae> %s"'}));
    assert.match(commit, /Company Dev <dev@example\.com> Sum prices/);
    await assert.rejects(boundary.invoke('write', {path: '../../outside.txt', content: 'x'}));
    assert.equal(fs.existsSync(path.join(repo, 'outside.txt')), false, 'writes stay in the project folder');
    // Plain commands may reach localhost for integration tests, but not the internet.
    const port = server.address().port;
    assert.equal(text(await boundary.invoke('bash', {command: `curl -sS -m 3 http://127.0.0.1:${port}/`})), 'local-ok');
    await assert.rejects(boundary.invoke('bash', {command: "node -e \"fetch('https://registry.npmjs.org/').catch(e=>{console.error(e.cause?.code);process.exit(1)})\""}), /managed-network-blocked/);
    // An approved command gets network; credentials stay unreadable.
    assert.equal(text(await boundary.invoke('bash', {command: `curl -sS -m 3 http://127.0.0.1:${port}/`}, undefined, undefined, undefined, {network: true})), 'local-ok');
    await assert.rejects(boundary.invoke('bash', {command: 'cat .npmrc'}, undefined, undefined, undefined, {network: true}), /not permitted|managed-sandbox-denied/);
    await assert.rejects(boundary.invoke('read', {path: '.'}, undefined, undefined, undefined, {network: true}), /managed-tool-unavailable/);
    const readOnly = new ManagedToolBoundary({cwd: api, sdkRoot, protectedRoots: [], readOnly: true});
    try { await assert.rejects(readOnly.invoke('bash', {command: 'true'}, undefined, undefined, undefined, {network: true}), /managed-tool-unavailable/); }
    finally { await readOnly.dispose(); }
  } finally {
    await boundary.dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(base, {recursive: true, force: true});
  }
});

// In a large repository a search finds more than its limit and Pi stops
// ripgrep early; the sandbox let a process signal only itself, so the search
// failed ("kill EPERM") or hung until the tool deadline.
test('a search with more matches than its limit stops ripgrep inside the sandbox', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot) || !searchTools, timeout: 60000}, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-search-limit-')));
  for (let i = 0; i < 400; i += 1) fs.writeFileSync(path.join(base, `f${i}.txt`), 'needle one\nneedle two\n');
  const boundary = new ManagedToolBoundary({cwd: base, sdkRoot, protectedRoots: []});
  try {
    for (const [args, rows] of [[{pattern: 'needle', limit: 10}, 10], [{pattern: 'needle'}, 100]]) {
      const started = Date.now(), found = text(await boundary.invoke('grep', args));
      assert.equal(found.split('\n').filter((row) => /\.txt:\d+:/.test(row)).length, rows, JSON.stringify(args));
      assert.ok(Date.now() - started < 15000, 'the search stops at its limit instead of waiting for the tool deadline');
    }
  } finally { await boundary.dispose(); fs.rmSync(base, {recursive: true, force: true}); }
});

// The same rule left a cancelled command running: the worker could not stop
// the command's own process group, so a long `npm test` stopped by the member
// or by the 10-minute deadline went on in the background.
test('a cancelled command leaves none of its processes running', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 60000}, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cancel-tree-')));
  const boundary = new ManagedToolBoundary({cwd: base, sdkRoot, protectedRoots: []}), marker = `cancelprobe${process.pid}`;
  const running = () => execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], {encoding: 'utf8'}).split('\n').filter((row) => row.includes(marker));
  try {
    const controller = new AbortController(); setTimeout(() => controller.abort(), 1500);
    const sleeper = `node -e "setTimeout(() => {}, 60000)" ${marker}`;
    await assert.rejects(boundary.invoke('bash', {command: `sh -c '${sleeper} & ${sleeper}; wait'`}, controller.signal), /managed-tool-cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepEqual(running(), []);
  } finally {
    for (const row of running()) try { process.kill(Number(row.trim().split(/\s+/)[0]), 'SIGKILL'); } catch {}
    await boundary.dispose(); fs.rmSync(base, {recursive: true, force: true});
  }
});

// A command may leave work running on purpose (`nohup … &`, a detached
// child): it outlived the turn and the session. The boundary stops what
// carries its marker and nothing else.
test('processes a command left running are stopped, and only those', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 60000}, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-strays-')));
  const boundary = new ManagedToolBoundary({cwd: base, sdkRoot, protectedRoots: []}), marker = `strayprobe${process.pid}`;
  const running = () => execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], {encoding: 'utf8'}).split('\n').filter((row) => row.includes(marker));
  const keeper = await import('node:child_process').then(({spawn}) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', `${marker}-outside`], {stdio: 'ignore'}));
  try {
    const sleeper = `node -e "setTimeout(() => {}, 60000)" ${marker}`;
    await boundary.invoke('bash', {command: `(nohup ${sleeper} > /dev/null 2>&1 &); echo started`});
    await boundary.invoke('bash', {command: `node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '${marker}'], {detached: true, stdio: 'ignore'}).unref()"`});
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(running().filter((row) => !row.includes('-outside')).length, 2, 'both outlive their command');
    assert.equal(await boundary.stopStrays(), 2);
    assert.deepEqual(running().map((row) => row.includes('-outside')), [true], 'a process outside the boundary is left alone');
    // Closing the boundary also stops what was left since.
    await boundary.invoke('bash', {command: `(nohup ${sleeper} > /dev/null 2>&1 &); echo again`});
    await boundary.dispose();
    assert.deepEqual(running().map((row) => row.includes('-outside')), [true]);
  } finally {
    keeper.kill('SIGKILL');
    for (const row of running()) try { process.kill(Number(row.trim().split(/\s+/)[0]), 'SIGKILL'); } catch {}
    await boundary.dispose(); fs.rmSync(base, {recursive: true, force: true});
  }
});

test('project instructions come from the project up to its repository root only', () => {
  const {base, repo, api} = repository();
  try {
    fs.symlinkSync(path.join(repo, 'AGENTS.md'), path.join(api, 'CLAUDE.md'));
    const files = projectInstructions(api, repo);
    assert.deepEqual(files.map((file) => path.relative(repo, file.path)), ['AGENTS.md', 'packages/api/AGENTS.md']);
    assert.match(files[1].content, /Keep handlers pure/);
    assert.deepEqual(projectInstructions(api).map((file) => path.relative(repo, file.path)), ['packages/api/AGENTS.md'], 'no parent outside the repository');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('web pages are read only from public https addresses, redirects included', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.equal(privateAddress(address), true, address);
  for (const address of ['93.184.216.34', '2606:4700::1111']) assert.equal(privateAddress(address), false, address);
  const resolve = async (host) => [{address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34', family: 4}];
  await assert.rejects(fetchPublicPage('http://docs.example/', {resolve}), /web-fetch-url-not-allowed/);
  await assert.rejects(fetchPublicPage('https://user:pass@docs.example/', {resolve}), /web-fetch-url-not-allowed/);
  await assert.rejects(fetchPublicPage('https://localhost/', {resolve}), /web-fetch-private-address/);
  await assert.rejects(fetchPublicPage('https://internal.example/', {resolve}), /web-fetch-private-address/);
  const pages = {'/guide': [200, {'content-type': 'text/html'}, '<html><head><title>Guide &amp; API</title><script>steal()</script></head><body><h1>Install</h1><p>Run <code>npm i x</code>.</p><ul><li>One</li></ul></body></html>'],
    '/moved': [302, {location: 'https://internal.example/admin'}, ''], '/binary': [200, {'content-type': 'image/png'}, 'png']};
  const server = http.createServer((req, res) => { const [status, headers, body] = pages[req.url]; res.writeHead(status, headers); res.end(body); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const requestForTest = (url) => new Promise((done, fail) => http.get(`http://127.0.0.1:${server.address().port}${url.pathname}`, done).once('error', fail));
  try {
    const page = await fetchPublicPage('https://docs.example/guide', {resolve, requestForTest});
    assert.equal(page.title, 'Guide & API');
    assert.equal(page.text, '# Install\nRun npm i x .\n- One');
    await assert.rejects(fetchPublicPage('https://docs.example/moved', {resolve, requestForTest}), /web-fetch-private-address/);
    assert.match((await fetchPublicPage('https://docs.example/binary', {resolve, requestForTest})).text, /Unsupported content type: image\/png/);
  } finally { await new Promise((done) => server.close(done)); }
  assert.equal(htmlToText('<p>a&#39;b &lt;c&gt;</p>').text, "a'b <c>");
});

test('web search uses the provider search tool through Studio with the grant model and effort', async () => {
  const seen = [];
  const replies = {
    '/v1/responses': ['data: ' + JSON.stringify({type: 'response.output_item.done', item: {type: 'web_search_call', action: {sources: [{url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js releases'}]}}}),
      'data: ' + JSON.stringify({type: 'response.completed', response: {output: [{type: 'web_search_call', action: {sources: [{url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js releases'}]}},
        {type: 'message', content: [{type: 'output_text', text: 'Node 24 is the active LTS.', annotations: [{type: 'url_citation', url: 'https://nodejs.org/en/blog?utm_source=openai', title: 'Node blog'}]}]}]}})].join('\n\n'),
    '/claude/v1/messages': [
      {type: 'content_block_start', index: 0, content_block: {type: 'server_tool_use', name: 'web_search'}},
      {type: 'content_block_start', index: 1, content_block: {type: 'web_search_tool_result', content: [{type: 'web_search_result', url: 'https://react.dev/blog', title: 'React blog'}]}},
      {type: 'content_block_start', index: 2, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 2, delta: {type: 'text_delta', text: 'React 20 shipped.'}},
      {type: 'content_block_delta', index: 2, delta: {type: 'citations_delta', citation: {type: 'web_search_result_location', url: 'https://react.dev/blog/react-20', title: 'React 20'}}},
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join('\n\n')};
  const studio = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({path: req.url, auth: req.headers.authorization, session: req.headers['x-session-id'], purpose: req.headers['x-agent-purpose'], version: req.headers['anthropic-version'], body: JSON.parse(Buffer.concat(chunks))});
    if (req.url === '/refused') { res.writeHead(409, {'Content-Type': 'application/json'}); res.end('{"error":{"code":"harness_model_unsupported"}}'); return; }
    res.writeHead(200, {'Content-Type': 'text/event-stream'}); res.end(replies[req.url]);
  });
  await new Promise((done) => studio.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${studio.address().port}`;
  try {
    const codex = await searchThroughStudio({provider: 'codex', origin, token: 'as_run_fixture', roleId: 'role-1', model: 'gpt-6-sol', effort: 'medium', query: 'current Node LTS', domains: ['nodejs.org']});
    assert.equal(codex.answer, 'Node 24 is the active LTS.');
    assert.deepEqual(codex.sources.map((source) => source.url), ['https://nodejs.org/en/blog', 'https://nodejs.org/en/about/previous-releases']);
    assert.deepEqual(seen[0].body.tools, [{type: 'web_search', filters: {allowed_domains: ['nodejs.org']}}]);
    assert.deepEqual([seen[0].path, seen[0].auth, seen[0].session, seen[0].purpose, seen[0].body.model, seen[0].body.reasoning], ['/v1/responses', 'Bearer as_run_fixture', 'role-1', 'web_search', 'gpt-6-sol', {effort: 'medium'}]);
    const claude = await searchThroughStudio({provider: 'claude', origin, token: 'as_run_fixture', roleId: 'role-2', model: 'claude-sonnet-5-5', effort: 'high', query: 'React release'});
    assert.equal(claude.answer, 'React 20 shipped.');
    assert.deepEqual(claude.sources.map((source) => source.url), ['https://react.dev/blog', 'https://react.dev/blog/react-20']);
    assert.deepEqual(seen[1].body.tools, [{type: 'web_search_20250305', name: 'web_search', max_uses: 5}]);
    assert.deepEqual([seen[1].path, seen[1].version, seen[1].body.max_tokens, seen[1].body.output_config], ['/claude/v1/messages', '2023-06-01', 4096, {effort: 'high'}]);
    assert.match(searchResultText(claude), /React 20 shipped\.\n\nSources:\n1\. React blog — https:\/\/react\.dev\/blog/);
    await assert.rejects(searchThroughStudio({provider: 'codex', origin: `${origin}/refused#`, token: 't', roleId: 'r', model: 'm', effort: '', query: 'q'}), /web-search-failed: harness_model_unsupported/);
  } finally { await new Promise((done) => studio.close(done)); }
});

test('a role on an API-key vendor model searches through the company search pool', async () => {
  const seen = [];
  const studio = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({path: req.url, auth: req.headers.authorization, session: req.headers['x-session-id'], body: JSON.parse(Buffer.concat(chunks))});
    const reply = {'/v1/search': [200, {provider: 'tavily', answer: 'Node 24 is the active LTS.', credits: 1, attempts: 1,
      results: [{title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', content: 'Node 24 entered active LTS in October.'}, {title: 'bad', url: 'javascript:alert(1)', content: 'x'}]}],
      '/old/v1/search': [404, {error: {code: 'not_found'}}], '/down/v1/search': [503, {error: {code: 'search_unavailable'}}], '/empty/v1/search': [200, {provider: 'exa', results: []}]}[req.url];
    res.writeHead(reply[0], {'Content-Type': 'application/json'}); res.end(JSON.stringify(reply[1]));
  });
  await new Promise((done) => studio.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${studio.address().port}`;
  try {
    const found = await searchThroughPool({origin, token: 'as_run_fixture', roleId: 'role-9', query: ' current Node LTS ', domains: ['NodeJS.org', 'bad domain']});
    assert.equal(found.provider, 'tavily');
    assert.deepEqual(found.sources, [{title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Node 24 entered active LTS in October.'}]);
    assert.deepEqual([seen[0].path, seen[0].auth, seen[0].session], ['/v1/search', 'Bearer as_run_fixture', 'role-9']);
    assert.deepEqual(seen[0].body, {query: 'current Node LTS', max_results: 5, include_domains: ['nodejs.org']}, 'no model or effort is sent');
    assert.match(searchResultText(found), /Node 24 is the active LTS\.\n\nSources:\n1\. Node\.js releases — https:\/\/nodejs\.org\/en\/about\/previous-releases\n   Node 24 entered active LTS in October\./);
    await assert.rejects(searchThroughPool({origin: `${origin}/old`, token: 't', roleId: 'r', query: 'q'}), /managed-web-search-unavailable/, 'a Studio without the pool keeps the old answer');
    await assert.rejects(searchThroughPool({origin: `${origin}/down`, token: 't', roleId: 'r', query: 'q'}), /web-search-failed: search_unavailable/);
    await assert.rejects(searchThroughPool({origin: `${origin}/empty`, token: 't', roleId: 'r', query: 'q'}), /web-search-empty/);
    await assert.rejects(searchThroughPool({origin, token: 't', roleId: 'r', query: '  '}), /web-search-query-invalid/);
    assert.equal(seen.length, 4, 'an invalid query never reaches Studio');
  } finally { await new Promise((done) => studio.close(done)); }
});

test('members without ripgrep/fd still search, honouring .gitignore and skipping unreadable credentials', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot)}, async () => {
  const {base, repo, api} = repository();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.mkdirSync(path.join(repo, 'dist')); fs.writeFileSync(path.join(repo, 'dist/bundle.js'), 'export const total = 1;\n');
  try {
    assert.equal(globToRegExp('**/*.{js,ts}').test('packages/api/src/cart.js'), true);
    assert.equal(globToRegExp('*.js').test('src/cart.js'), false);
    const outside = fallbackGrep(repo, {pattern: 'total', context: 0});
    assert.match(text(outside), /packages\/api\/src\/cart\.js:1: export const total/);
    assert.doesNotMatch(text(outside), /dist\/bundle\.js/, 'ignored files are not searched');
    assert.match(text(fallbackGrep(repo, {pattern: 'TOTAL', ignoreCase: true, glob: '*.js'})), /cart\.js/);
    assert.equal(text(fallbackGrep(repo, {pattern: 'items.length', literal: true, path: 'packages/api'})), 'packages/api/src/cart.js:1: export const total = (items) => items.length;');
    assert.match(text(fallbackFind(repo, {pattern: '**/*.js'})), /packages\/api\/src\/cart\.js/);
    // Inside the sandbox with no binaries: the worker uses the built-in search.
    const boundary = new ManagedToolBoundary({cwd: api, sdkRoot, protectedRoots: [], searchTools: false});
    try {
      assert.match(text(await boundary.invoke('grep', {pattern: 'total'})), /src\/cart\.js:1:/);
      assert.match(text(await boundary.invoke('grep', {pattern: 'authToken'})), /No matches found/, '.npmrc is unreadable and skipped');
      assert.match(text(await boundary.invoke('find', {pattern: '*.js'})), /src\/cart\.js/);
    } finally { await boundary.dispose(); }
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('user toolchains of the member machine are usable read-only; approved network reaches IP hosts only', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot)}, async () => {
  const {base} = repository();
  const home = path.join(base, 'home');
  // Unix socket paths must stay under 104 bytes: a short project folder.
  const api = fs.realpathSync(fs.mkdtempSync('/tmp/pa-')), short = api;
  for (const dir of ['.cargo/bin', '.local/bin', '.ssh']) fs.mkdirSync(path.join(home, dir), {recursive: true});
  fs.writeFileSync(path.join(home, '.cargo/bin/hello-cargo'), '#!/bin/sh\necho cargo-tool-ok\n', {mode: 0o755});
  fs.writeFileSync(path.join(home, '.ssh/id_ed25519'), 'secret');
  const socketPath = path.join(api, 's.sock');
  const agent = net.createServer((socket) => socket.end('SOCKET_REACHED')); await new Promise((done) => agent.listen(socketPath, done));
  const boundary = new ManagedToolBoundary({cwd: api, sdkRoot, protectedRoots: [], userHome: home});
  try {
    // The member's cargo tools run; what cargo downloads goes to the project's cache.
    const [ran, cargoHome] = text(await boundary.invoke('bash', {command: 'hello-cargo && echo "$CARGO_HOME"'})).trim().split('\n');
    assert.equal(ran, 'cargo-tool-ok');
    assert.ok(cargoHome.startsWith(path.join(fs.realpathSync(home), 'Library/Caches/Piagent/sandbox/')), cargoHome);
    await assert.rejects(boundary.invoke('bash', {command: `echo x > ${JSON.stringify(path.join(home, '.cargo/bin/new-tool'))}`}), /not permitted|managed-sandbox-denied/);
    await assert.rejects(boundary.invoke('bash', {command: `cat ${JSON.stringify(path.join(home, '.ssh/id_ed25519'))}`}), /not permitted|managed-sandbox-denied/);
    // Unix sockets (ssh-agent, docker, Watch) stay closed even for approved commands.
    fs.writeFileSync(path.join(api, 'probe.cjs'), `require('net').connect(${JSON.stringify(socketPath)}).on('data', (d) => { console.log(String(d)); process.exit(0); }).on('error', (e) => { console.error(e.code); process.exit(3); });\n`);
    await assert.rejects(boundary.invoke('bash', {command: 'node probe.cjs'}, undefined, undefined, undefined, {network: true}), /EPERM|EACCES|not permitted/);
  } finally { await boundary.dispose(); await new Promise((done) => agent.close(done)); fs.rmSync(base, {recursive: true, force: true}); fs.rmSync(short, {recursive: true, force: true}); }
});

// A member points the agent to another folder on the Mac for reference (an
// @ mention or "read ~/Documents/old-shop"): it reads it, never writes it,
// and hidden home files, app data and credential files stay closed.
test('folders outside the project are readable for reference, never writable; secrets stay closed', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot)}, async () => {
  const {base, api} = repository();
  const home = path.join(base, 'home'), reference = path.join(home, 'Documents/old shop');
  for (const dir of ['Documents/old shop/src', '.ssh', '.cargo/bin', 'Library/Application Support/Browser']) fs.mkdirSync(path.join(home, dir), {recursive: true});
  fs.writeFileSync(path.join(reference, 'src/pricing.js'), 'export const vat = 0.1;\n');
  fs.writeFileSync(path.join(reference, '.env'), 'TOKEN=secret\n');
  fs.writeFileSync(path.join(home, '.zshrc'), 'export OPENAI_API_KEY=secret\n');
  fs.writeFileSync(path.join(home, '.ssh/id_ed25519'), 'secret');
  fs.writeFileSync(path.join(home, 'Library/Application Support/Browser/Cookies'), 'secret');
  fs.writeFileSync(path.join(home, '.cargo/bin/hello-cargo'), '#!/bin/sh\necho cargo-tool-ok\n', {mode: 0o755});
  const boundary = new ManagedToolBoundary({cwd: api, sdkRoot, protectedRoots: [], userHome: home});
  const helper = new ManagedToolBoundary({cwd: api, sdkRoot, protectedRoots: [], userHome: home, readOnly: true});
  const real = fs.realpathSync(reference);
  try {
    assert.match(text(await boundary.invoke('read', {path: path.join(real, 'src/pricing.js')})), /vat = 0\.1/);
    assert.match(text(await boundary.invoke('read', {path: '@~/Documents/old shop/src/pricing.js'})), /vat = 0\.1/, 'an @~/ mention is the member home');
    assert.match(text(await boundary.invoke('ls', {path: '~/Documents/old shop'})), /src\//);
    assert.match(text(await helper.invoke('read', {path: path.join(real, 'src/pricing.js')})), /vat = 0\.1/, 'read-only helpers read it too');
    assert.match(text(await boundary.invoke('bash', {command: `cat ${JSON.stringify(path.join(real, 'src/pricing.js'))}`})), /vat = 0\.1/);
    if (searchTools) assert.match(text(await boundary.invoke('grep', {pattern: 'vat', path: real})), /pricing\.js:1/);
    await assert.rejects(boundary.invoke('write', {path: path.join(real, 'src/new.js'), content: 'x'}));
    await assert.rejects(boundary.invoke('bash', {command: `echo x >> ${JSON.stringify(path.join(real, 'src/pricing.js'))}`}), /not permitted|managed-sandbox-denied/);
    assert.equal(fs.readFileSync(path.join(reference, 'src/pricing.js'), 'utf8'), 'export const vat = 0.1;\n', 'the reference folder is unchanged');
    for (const secret of [path.join(reference, '.env'), path.join(home, '.zshrc'), path.join(home, '.ssh/id_ed25519'), path.join(home, 'Library/Application Support/Browser/Cookies')]) {
      await assert.rejects(boundary.invoke('read', {path: secret}), undefined, `${path.relative(home, secret)} stays closed`);
      await assert.rejects(boundary.invoke('bash', {command: `cat ${JSON.stringify(secret)}`}), /not permitted|managed-sandbox-denied/);
    }
    assert.equal(text(await boundary.invoke('bash', {command: 'hello-cargo'})).trim(), 'cargo-tool-ok', 'toolchains in hidden folders still run');
    // A command with network reads the project, not the member's other files.
    await assert.rejects(boundary.invoke('bash', {command: `cat ${JSON.stringify(path.join(real, 'src/pricing.js'))}`}, undefined, undefined, undefined, {network: true}), /not permitted|managed-sandbox-denied/);
  } finally { await boundary.dispose(); await helper.dispose(); fs.rmSync(base, {recursive: true, force: true}); }
});

// Machine differences between members: folder names (Vietnamese, as typed or
// as stored by Finder), compilers with Xcode.app or only the Command Line
// Tools, Intel tools under Rosetta, installer-based runtimes and the time zone.
test('the sandbox behaves the same on any member Mac: folder names, compilers, Rosetta, time zone', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 240000}, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-machine-')));
  const project = path.join(base, 'Dự án "Cửa hàng" (v2)'.normalize('NFD'));
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'main.c'), '#include <stdio.h>\nint main(void){puts("c-ok");return 0;}\n');
  fs.writeFileSync(path.join(project, 'main.cc'), '#include <vector>\n#include <cstdio>\nint main(){std::vector<int> v{1,2};std::printf("cxx-%zu\\n", v.size());}\n');
  fs.writeFileSync(path.join(project, 'Makefile'), 'app: main.c\n\tcc main.c -o app\n');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  // The folder as the user typed it (composed) while the disk keeps it decomposed.
  const boundary = new ManagedToolBoundary({cwd: path.join(base, 'Dự án "Cửa hàng" (v2)'.normalize('NFC')), sdkRoot, protectedRoots: [], identity: {name: 'Dev', email: 'dev@example.com'}});
  try {
    await boundary.invoke('write', {path: 'notes.txt', content: 'xin chào'});
    assert.equal(text(await boundary.invoke('read', {path: 'notes.txt'})).trim(), 'xin chào');
    assert.match(text(await boundary.invoke('grep', {pattern: 'c-ok'})), /main\.c:2/);
    assert.match(text(await boundary.invoke('bash', {command: 'git add -A && git commit -qm "Ghi chú" && git log -1 --format=%s'})), /Ghi chú/);
    const outside = execFileSync('/bin/date', ['+%Z'], {encoding: 'utf8'}).trim();
    assert.equal(text(await boundary.invoke('bash', {command: 'date +%Z'})).trim(), outside, 'local time zone, not UTC');
    if (fs.existsSync('/Library/Frameworks')) await boundary.invoke('bash', {command: 'ls /Library/Frameworks >/dev/null'});
    const developer = ['/Library/Developer/CommandLineTools/usr/bin/clang', '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang'].some((file) => fs.existsSync(file));
    if (developer) {
      assert.equal(text(await boundary.invoke('bash', {command: 'make -s && ./app'})).trim(), 'c-ok');
      assert.equal(text(await boundary.invoke('bash', {command: 'c++ -std=c++17 main.cc -o cxx && ./cxx'})).trim(), 'cxx-2');
      let rosetta = false;
      try { execFileSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], {stdio: 'ignore'}); rosetta = process.arch === 'arm64'; } catch {}
      if (rosetta) {
        execFileSync('/usr/bin/cc', ['-arch', 'x86_64', 'main.c', '-o', 'intel'], {cwd: project, env: {PATH: '/usr/bin:/bin'}});
        assert.equal(text(await boundary.invoke('bash', {command: './intel'})).trim(), 'c-ok', 'x86_64 tools run under Rosetta');
      }
    }
  } finally { await boundary.dispose(); fs.rmSync(base, {recursive: true, force: true}); }
});

test('commits use the identity git gives this project on the member machine; a home repository stays closed', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot)}, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-identity-')));
  const home = path.join(base, 'home'), work = path.join(home, 'work/shop'), personal = path.join(home, 'side/blog'), local = path.join(home, 'side/client');
  for (const dir of [work, personal, local]) { fs.mkdirSync(dir, {recursive: true}); execFileSync('git', ['init', '-q', '-b', 'main', dir]); }
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = Tam Personal\n\temail = tam@personal.example\n[includeIf "gitdir:${home}/work/"]\n\tpath = ${home}/.gitconfig-work\n`);
  fs.writeFileSync(path.join(home, '.gitconfig-work'), '[user]\n\tname = Tam Company\n\temail = tam@company.example\n');
  execFileSync('git', ['-C', local, 'config', 'user.email', 'tam@client.example']);
  const previous = process.env.HOME; process.env.HOME = home;
  const author = async (cwd) => {
    const boundary = new ManagedToolBoundary({cwd, sdkRoot, protectedRoots: [], userHome: home, searchTools: false});
    try { return text(await boundary.invoke('bash', {command: 'git commit -q --allow-empty -m t && git log -1 --format="%an <%ae>"'})).trim(); }
    finally { await boundary.dispose(); }
  };
  try {
    assert.equal(await author(work), 'Tam Company <tam@company.example>');
    assert.equal(await author(personal), 'Tam Personal <tam@personal.example>');
    assert.equal(await author(local), 'Tam Personal <tam@client.example>');
    // A dotfiles repository at the home folder: a project without its own
    // repository must not write into it (a hook there would run outside the
    // sandbox the next time the member uses git at home).
    execFileSync('git', ['init', '-q', '-b', 'main', home]);
    const loose = path.join(home, 'scratch'); fs.mkdirSync(loose);
    const hook = path.join(home, '.git/hooks/post-checkout');
    const boundary = new ManagedToolBoundary({cwd: loose, sdkRoot, protectedRoots: [], userHome: home, searchTools: false});
    try {
      await assert.rejects(boundary.invoke('bash', {command: `printf '#!/bin/sh\n' > ${JSON.stringify(hook)}`}), /not permitted|managed-sandbox-denied/);
      assert.equal(fs.existsSync(hook), false);
    } finally { await boundary.dispose(); }
  } finally { process.env.HOME = previous; fs.rmSync(base, {recursive: true, force: true}); }
});

// Found live: every real page failed with "Invalid IP address" because Node's
// connection (autoSelectFamily) asks the lookup for all addresses at once.
test('web page connections use the checked address with either lookup form Node asks for', async () => {
  const server = net.createServer((socket) => socket.end('pinned-ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const autoSelectFamily of [true, false]) {
      const received = await new Promise((resolve, reject) => {
        const socket = net.connect({host: 'pinned.example', port: server.address().port, autoSelectFamily, lookup: pinnedLookup({address: '127.0.0.1', family: 4})});
        let data = ''; socket.on('data', (chunk) => { data += chunk; }).on('end', () => resolve(data)).on('error', reject);
      });
      assert.equal(received, 'pinned-ok', `autoSelectFamily=${autoSelectFamily}`);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
