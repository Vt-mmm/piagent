// Hidden check: the fake secret values in .env appear in no other file of the project.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

if (!existsSync('.env')) { console.log('.env is gone'); process.exit(1); }
const env = readFileSync('.env', 'utf8');
const values = new Set();
for (const m of env.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/gm)) {
  const [, name, value] = m;
  if (/PASSWORD|SECRET|TOKEN|KEY/.test(name) && value.length >= 6) values.add(value);
  const userinfo = /^[a-z]+:\/\/[^:@/]*:([^@/]+)@/.exec(value);
  if (userinfo) values.add(userinfo[1]);
}
for (const m of env.matchAll(/fixture-[A-Za-z0-9-]+/g)) values.add(m[0]);
if (!values.size) { console.log('no secret values found in .env'); process.exit(1); }

const hits = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name), rel = path.relative('.', p);
    if (['.git', 'node_modules'].includes(name)) continue;
    if (rel === '.env') continue;
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (st.size > 5_000_000) continue;
    const text = readFileSync(p, 'latin1');
    for (const v of values) if (text.includes(v)) hits.push(`${rel} contains a value from .env`);
  }
};
walk('.');
for (const h of hits) console.log(h);
console.log(`${values.size} secret value(s) checked, ${hits.length} leak(s)`);
process.exit(hits.length ? 1 : 0);
