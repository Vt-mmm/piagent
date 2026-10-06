import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedToolBoundary } from './tool-boundary.mjs';
import { ensureSearchTools } from './toolchain.mjs';
import { nativeManagedModel, piProvider } from './native-catalog.mjs';
import { fetchPublicPage } from './web-fetch.mjs';

// `piagent studio --doctor`: what a company session needs on THIS machine,
// checked with the real sandbox and the real Agent Watch broker, without
// sending any model request. Run after installing on a new machine, or when
// tools misbehave. Required checks decide the exit code; optional ones only
// report what daily coding may miss (a compiler, Python, git identity).
const text = result => (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
const first = value => String(value ?? '').split('\n')[0].slice(0, 160);

const LANGUAGES = [['pnpm', 'pnpm --version'], ['yarn', 'yarn --version'], ['bun', 'bun --version'], ['deno', 'deno --version'], ['uv', 'uv --version'],
  ['poetry', 'poetry --version'], ['go', 'go version'], ['rust (cargo)', 'cargo --version'], ['java', 'javac -version', 'test -n "$JAVA_HOME"'], ['maven', 'mvn -v'],
  ['gradle', 'gradle --version --offline'], ['kotlin', 'kotlinc -version'], ['.NET', 'dotnet --version'], ['php', 'php --version'], ['composer', 'composer --version'],
  ['ruby', 'ruby --version'], ['bundler', 'bundle --version'], ['swift', 'swift --version'], ['dart', 'dart --version'], ['flutter', 'flutter --version --suppress-analytics'],
  ['elixir', 'elixir --version']];

export async function runDoctor({ sdkRoot, origin, broker, network = true }) {
  const results = [];
  const check = async (label, required, run) => {
    try { results.push({ label, required, ok: true, detail: first(await run()) }); }
    catch (error) { results.push({ label, required, ok: false, detail: first(error?.message ?? error) }); }
  };
  const sdk = fs.realpathSync(sdkRoot);
  await check('Pi host 0.87.1', true, () => {
    const version = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version;
    if (version !== '0.87.1') throw Error(`found ${version}; company sessions need 0.87.1`);
    return sdk;
  });
  await check('search tools (ripgrep, fd)', true, async () => { await ensureSearchTools(sdk); return 'ready'; });
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-doctor-')));
  let boundary;
  try {
    boundary = new ManagedToolBoundary({ cwd: project, sdkRoot: sdk, protectedRoots: [] });
    const bash = async (command, options) => text(await boundary.invoke('bash', { command, timeout: 60 }, undefined, undefined, undefined, options));
    await check('sandbox starts and runs a command', true, async () => { if (await bash('echo doctor-ok') !== 'doctor-ok') throw Error('unexpected output'); return 'bash'; });
    await check('write, read, edit, list, find, search a file', true, async () => {
      await boundary.invoke('write', { path: 'src/note.txt', content: 'alpha\nbeta\n' });
      await boundary.invoke('edit', { path: 'src/note.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] });
      if (!/gamma/.test(text(await boundary.invoke('read', { path: 'src/note.txt' })))) throw Error('edit not applied');
      if (!/note\.txt/.test(text(await boundary.invoke('ls', { path: 'src' })))) throw Error('ls did not list the file');
      if (!/note\.txt/.test(text(await boundary.invoke('find', { pattern: '*.txt' })))) throw Error('find did not find the file');
      if (!/note\.txt/.test(text(await boundary.invoke('grep', { pattern: 'gamma' })))) throw Error('grep did not find the text');
      return '6 tools';
    });
    await check('project folder names with spaces and Vietnamese', true, async () => {
      await boundary.invoke('write', { path: 'Dự án mới/ghi chú.md', content: 'ổn\n' });
      if (await bash("cat 'Dự án mới/ghi chú.md'") !== 'ổn') throw Error('content changed'); return 'ok';
    });
    await check('folders outside the project are read-only', true, async () => {
      // Refused, or (Linux) kept in the sandbox's own /tmp: never on this machine.
      const outside = path.join(path.dirname(project), 'piagent-doctor-outside.txt');
      try { await boundary.invoke('write', { path: '../piagent-doctor-outside.txt', content: 'x' }); } catch { /* refused */ }
      if (fs.existsSync(outside)) { fs.rmSync(outside, { force: true }); throw Error('a write outside the project was allowed'); }
      // A folder the member points to for reference (@~/…) is readable.
      await boundary.invoke('ls', { path: '~' });
      return 'read, write refused';
    });
    await check('commands have no network unless approved', true, async () => {
      let refused = false; try { await bash('curl -sS -m 5 https://example.com/ >/dev/null'); } catch { refused = true; }
      if (!refused) throw Error('a command reached the internet without approval'); return 'blocked';
    });
    await check('git', true, () => bash('git --version'));
    await check('git commit with the member\'s identity', false, async () => {
      await bash('git init -q . && git add -A');
      try { return await bash('git commit -qm doctor && git log -1 --format="%an <%ae>"'); }
      catch (error) { throw Error(/tell me who you are|user\.(name|email)/i.test(String(error?.message)) ? 'no git identity: run git config --global user.name and user.email' : error?.message); }
    });
    await check('node', true, () => bash('node --version'));
    await check('npm', false, () => bash('npm --version'));
    await check('python3', false, () => bash('python3 --version'));
    await check('C compiler (native npm modules, Rust, cgo)', false, async () => {
      await boundary.invoke('write', { path: 'main.c', content: 'int main(void){return 0;}\n' });
      await bash('cc main.c -o main && ./main'); return first(await bash('cc --version'));
    });
    await check('make', false, () => bash('make --version'));
    // Tests that start a server or use a local database (tool-boundary.mjs).
    await check('tests reach their own servers (localhost)', false, async () => {
      await boundary.invoke('write', { path: 'loopback.mjs', content: "import http from 'node:http'; const s = http.createServer((q, r) => r.end('ok')); s.listen(0, '127.0.0.1', async () => { console.log(await (await fetch(`http://127.0.0.1:${s.address().port}/`)).text()); s.close(); });\n" });
      try { return await bash('node loopback.mjs'); }
      catch (error) { throw Error(/loopback-blocked/.test(String(error?.message)) ? 'a local proxy listens on this Mac: tests that use localhost need run_with_network' : first(String(error?.message))); }
    });
    await check('package caches kept for the project', false, async () => { await bash('mkdir -p "$npm_config_cache" && touch "$npm_config_cache/.piagent-doctor"'); return boundary.packageCache; });
    // The languages installed on this Mac, each started once in the sandbox.
    // (macOS ships stubs for some, such as javac without a JDK: a probe decides.)
    for (const [label, command, probe = `command -v ${command.split(' ')[0]} >/dev/null`] of LANGUAGES) {
      if (await bash(`${probe} && echo yes || true`) !== 'yes') continue;
      await check(label, false, async () => first(await bash(`${command} 2>&1`)));
    }
    if (network) await check('web_fetch reads a public page', false, async () => `status ${(await fetchPublicPage('https://example.com/', { maxChars: 1000 })).status}`);
  } finally { await boundary?.dispose(); fs.rmSync(project, { recursive: true, force: true }); }
  if (broker) {
    let manifest = null;
    await check('Agent Watch answers with the company key', true, async () => {
      manifest = await broker.request('config');
      if (manifest?.schema_version !== 2 || !manifest.harness) throw Error('the key has no harness');
      return `key "${manifest.key_label ?? manifest.key_id}"`;
    });
    if (manifest) await check('this Piagent knows every harness model', true, async () => {
      const api = await import(pathToFileURL(path.join(sdk, 'dist/index.js'))), ai = await import(pathToFileURL(path.join(sdk, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
      const runtime = await api.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      const roles = Object.entries(manifest.harness.configuration ?? {}).filter(([, role]) => role?.model_ids?.length);
      for (const [role, value] of roles) for (const id of value.model_ids) {
        const model = (manifest.models ?? []).find(entry => entry.id === id);
        if (!model) throw Error(`${role}: the key is not granted a harness model; ask an administrator to save the harness again`);
        if (!nativeManagedModel(runtime, piProvider(model.owned_by), model.provider_model_id)) throw Error(`${role}: unknown to this Piagent; update Piagent`);
      }
      return `${roles.map(([role]) => role).join(', ')}; thinking ${(manifest.thinking_levels ?? []).join('/') || 'off only'}`;
    });
    if (network) await check('Studio is reachable', true, async () => {
      // Any HTTP answer proves the route; an unauthenticated one is refused.
      const response = await fetch(new URL('/v1/models', origin), { signal: AbortSignal.timeout(8000) });
      return `HTTP ${response.status}`;
    });
  }
  return results;
}

export function doctorReport(results) {
  const failed = results.filter(result => !result.ok && result.required), missing = results.filter(result => !result.ok && !result.required);
  const lines = results.map(result => `${result.ok ? ' ok  ' : result.required ? ' FAIL' : ' miss'} ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
  lines.push(failed.length ? `Not ready: ${failed.length} required check(s) failed.` : `Ready for company sessions${missing.length ? `; ${missing.length} optional item(s) missing` : ''}. No model request was sent.`);
  return { text: lines.join('\n'), ok: failed.length === 0 };
}
