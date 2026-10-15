import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { TsDiagnostics } from '../packages/piagent-core/managed/ts-diagnostics.mjs';
import { processEditTools } from '../packages/piagent-core/managed/workflow.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// The project's own TypeScript reports a file's errors right after the agent
// changes it, from inside the command sandbox.
const sdkRoot = piSdkRoot();
// This repository's TypeScript (7, native), or another package to check the
// language-service path of TypeScript 5 and 6 (PIAGENT_TEST_TYPESCRIPT=<package folder>).
const typescript = process.env.PIAGENT_TEST_TYPESCRIPT ?? path.resolve(import.meta.dirname, '../node_modules/typescript');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot) && fs.existsSync(typescript);

function project({ withTypescript = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-ts-')));
  fs.mkdirSync(path.join(base, 'src'));
  fs.writeFileSync(path.join(base, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', allowJs: true }, include: ['src'] }));
  fs.writeFileSync(path.join(base, 'src/sum.ts'), 'export const sum = (a: number, b: number): number => a + b;\n');
  // Copied, not linked: the sandbox reads the project.
  if (withTypescript) {
    fs.cpSync(typescript, path.join(base, 'node_modules/typescript'), { recursive: true });
    // TypeScript 7 runs its native compiler from a platform package beside it.
    const native = path.resolve(typescript, '../@typescript');
    if (Number.parseInt(JSON.parse(fs.readFileSync(path.join(typescript, 'package.json'), 'utf8')).version, 10) >= 7 && fs.existsSync(native)) fs.cpSync(native, path.join(base, 'node_modules/@typescript'), { recursive: true });
  }
  return base;
}

test('a TypeScript error is reported for the file just changed, and only while it is there', { skip: !supported, timeout: 120000 }, async () => {
  const base = project(), boundary = new ManagedToolBoundary({ cwd: base, sdkRoot, protectedRoots: [], proxyPorts: [] });
  const diagnostics = new TsDiagnostics(boundary, { timeout: 60000 });
  try {
    fs.writeFileSync(path.join(base, 'src/use.ts'), "import { sum } from './sum';\nexport const total: string = sum(1, 2);\n");
    const note = await diagnostics.check('src/use.ts');
    assert.match(note, /^\n\[TypeScript, tsconfig\.json\] 1 error\(s\) in src\/use\.ts after this change:\nsrc\/use\.ts:2:14 TS2322 Type 'number' is not assignable to type 'string'\./);
    fs.writeFileSync(path.join(base, 'src/use.ts'), "import { sum } from './sum';\nexport const total: number = sum(1, 2);\n");
    assert.equal(await diagnostics.check('src/use.ts'), '', 'nothing to say once fixed');
    // A JavaScript syntax error; files outside these languages and in node_modules are not checked.
    fs.writeFileSync(path.join(base, 'src/broken.js'), 'export const x = ;\n');
    assert.match(await diagnostics.check('src/broken.js'), /src\/broken\.js:1:18 TS1109 Expression expected/);
    // tsc checks no types while a file has a syntax error: the note says so instead of keeping quiet.
    fs.writeFileSync(path.join(base, 'src/use.ts'), "import { sum } from './sum';\nexport const total: string = sum(1, 2);\n");
    const unchecked = await diagnostics.check('src/use.ts');
    // TypeScript 7's tsc stops there; the language service of 5 and 6 still checks the file.
    if (Number.parseInt(JSON.parse(fs.readFileSync(path.join(typescript, 'package.json'), 'utf8')).version, 10) >= 7)
      assert.match(unchecked, /src\/use\.ts was not type-checked: tsc stops at syntax errors elsewhere in the project:\nsrc\/broken\.js:1:18 TS1109 Expression expected/);
    else assert.match(unchecked, /src\/use\.ts:2:14 TS2322/);
    fs.rmSync(path.join(base, 'src/broken.js'));
    assert.match(await diagnostics.check('src/use.ts'), /src\/use\.ts:2:14 TS2322/);
    assert.equal(diagnostics.applies('README.md'), false);
    assert.equal(diagnostics.applies('node_modules/x/index.ts'), false);
    // The edit tool carries the note; the result is otherwise unchanged.
    const session = { boundary, session: { sessionManager: { getEntries: () => [] } }, refreshReview: async () => {} };
    const [edit] = processEditTools(session, [{ name: 'edit', execute: async (_id, args) => { fs.writeFileSync(path.join(base, args.path), "export const late: boolean = 'no';\n"); return { content: [{ type: 'text', text: 'Edited.' }] }; } }]);
    const result = await edit.execute('call', { path: 'src/late.ts' });
    assert.equal(result.content[0].text, 'Edited.');
    assert.match(result.content[1].text, /src\/late\.ts:1:14 TS2322/);
  } finally { diagnostics.dispose(); await boundary.dispose(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('without the project\'s TypeScript, or before a slow first answer, nothing is added', { skip: !supported, timeout: 120000 }, async () => {
  const bare = project({ withTypescript: false }), boundary = new ManagedToolBoundary({ cwd: bare, sdkRoot, protectedRoots: [], proxyPorts: [] });
  try {
    fs.writeFileSync(path.join(bare, 'src/use.ts'), 'export const total: string = 1;\n');
    assert.equal(await new TsDiagnostics(boundary, { timeout: 60000 }).check('src/use.ts'), '');
    // An answer that does not come in time leaves the edit alone.
    assert.equal(await new TsDiagnostics(boundary, { timeout: 1 }).check('src/use.ts'), '');
  } finally { await boundary.dispose(); fs.rmSync(bare, { recursive: true, force: true }); }
});
