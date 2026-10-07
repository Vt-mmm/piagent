import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const moduleUrl = pathToFileURL(path.resolve('packages/piagent-webui/gateway/pi-host.ts')).href;
for (const location of ['Path', 'NPM_CONFIG_PREFIX']) {
  test(`Windows discovers a custom npm host through ${location} without where.exe`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-host-prefix-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stale = path.join(directory, 'stale'), prefix = path.join(directory, 'prefix with spaces');
    const host = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
    fs.mkdirSync(stale); fs.mkdirSync(host, { recursive: true });
    fs.writeFileSync(path.join(stale, 'pi.cmd'), '@exit /b 1\r\n');
    fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.0.0' }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'npm_config_prefix'].includes(key.toLowerCase())));
    env.Path = stale;
    env[location] = location === 'Path' ? `${stale};"${prefix}"` : prefix;
    // On macOS/Linux exercise Windows discovery using real fixture files;
    // the Windows workflow also runs this with native Windows path semantics.
    const script = `Object.defineProperty(process, 'platform', {value: 'win32'});
      const {installedPiHostRoot, loadPinnedPiHost} = await import(${JSON.stringify(moduleUrl)});
      const assert = (await import('node:assert/strict')).default;
      assert.equal(installedPiHostRoot(), ${JSON.stringify(host)});
      await assert.rejects(loadPinnedPiHost('0.87.1'), /pi-host-version-mismatch/);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr || String(child.error ?? ''));
  });
}
