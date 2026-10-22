// Hidden check (p5): the legacy router is gone and its replacement is split into small modern modules.
import fs from 'node:fs';
import path from 'node:path';

const problems = [];
// An import of the legacy file (comments that mention it are fine).
const IMPORTS_LEGACY = /(from\s*|import\s*\(\s*|require\s*\(\s*)['"`][^'"`]*router-old/;
const web = 'services/web-js';
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];

if (fs.existsSync(`${web}/src/legacy/router-old.js`)) problems.push('src/legacy/router-old.js still exists');
const modules = walk(`${web}/src/router`).filter(f => f.endsWith('.js'));
if (!fs.existsSync(`${web}/src/router/index.js`)) problems.push('src/router/index.js is missing');
if (modules.length < 6) problems.push(`src/router has ${modules.length} .js module(s), expected at least 6`);
for (const file of modules) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').length;
  if (lines > 400) problems.push(`${file} has ${lines} lines (max 400)`);
  if (/^\s*var\s/m.test(text)) problems.push(`${file} still declares var`);
  if (IMPORTS_LEGACY.test(text)) problems.push(`${file} imports the legacy router`);
}
for (const file of [...walk(`${web}/src`), ...walk(`${web}/test`)].filter(f => f.endsWith('.js'))) {
  if (IMPORTS_LEGACY.test(fs.readFileSync(file, 'utf8')) && !/hidden/.test(path.basename(file))) problems.push(`${file} still imports router-old`);
}
const own = `${web}/test/router-golden.test.js`;
if (!fs.existsSync(own)) problems.push('test/router-golden.test.js is missing');
const fixture = `${web}/test/fixtures/router-golden.json`;
if (!fs.existsSync(fixture)) problems.push('test/fixtures/router-golden.json is missing');
else {
  try {
    const cases = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    if (!Array.isArray(cases) || cases.length < 100) problems.push(`test/fixtures/router-golden.json has ${Array.isArray(cases) ? cases.length : 'no'} cases (need >= 100)`);
    else if (!cases.every(c => c && c.request && c.response && 'status' in c.response)) problems.push('router-golden.json entries must be { request, response: { status, headers, body } }');
  } catch (error) { problems.push(`router-golden.json is not JSON: ${error.message}`); }
}
const exported = await import(path.resolve(`${web}/src/index.js`)).catch(error => ({ error }));
if (exported.error) problems.push(`src/index.js does not load: ${exported.error.message}`);
else if (typeof exported.adminRoute !== 'function') problems.push('src/index.js does not export adminRoute');
for (const p of problems) console.log(p);
console.log(`${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
