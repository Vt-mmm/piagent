import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, 'packages/piagent-core/managed/dist/workspace');
await build({ configFile: false, root, logLevel: 'error', ssr: { noExternal: true }, build: {
  ssr: true,
  outDir: output, emptyOutDir: true, minify: false,
  rolldownOptions: { input: { worker: path.join(root, 'packages/piagent-core/runtime/inspection/workspace-worker.ts'),
    'workspace-search-index': path.join(root, 'packages/piagent-core/extensions/workspace-search-index.mjs') }, output: { entryFileNames: '[name].mjs' } }
} });
// Keep installed policy data inside the already-readable runtime directory.
const files = ['packages/piagent-core/policies/base-policy.json',
  ...fs.readdirSync(path.join(root, 'adapters')).filter(name => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    .map(name => `adapters/${name}/profile.json`).filter(file => fs.existsSync(path.join(root, file)))];
for (const file of files) {
  const target = path.join(output, 'assets', file);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target);
}
const pins = [...fs.readdirSync(output, { recursive: true }).filter(file => file.endsWith('.mjs') || file.endsWith('.js')), ...files.map(file => `assets/${file}`)].map(file => ({ file,
  sha256: createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex') }));
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, files: pins }, null, 2) + '\n');
process.stdout.write(`Built workspace boundary worker and ${files.length} policy assets\n`);
