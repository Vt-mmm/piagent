import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { after, test as nodeTest } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { managedResourceLoader } from '../packages/piagent-core/managed/resource-loader.mjs';

const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
// The boundary runs Pi's own tools in the macOS sandbox: without the installed
// Pi SDK (CI runners) or off macOS there is nothing to exercise.
const supported=process.platform==='darwin'&&fsSync.existsSync(path.join(sdkRoot,'dist/index.js'));
const test=(name,options,fn)=>typeof options==='function'?nodeTest(name,{skip:!supported},options):nodeTest(name,{...options,skip:!supported||options.skip},fn);
const api=supported?await import(pathToFileURL(path.join(sdkRoot,'dist/index.js')).href):null;
const base=await fs.mkdtemp(path.join(os.tmpdir(),'managed-boundary-test-'));
const cwd=path.join(base,'project'),secretRoot=path.join(base,'private');
await fs.mkdir(cwd);await fs.mkdir(secretRoot);
await fs.writeFile(path.join(secretRoot,'synthetic-key'),'FIXTURE-PRIVATE-VALUE');
const boundary=supported?new ManagedToolBoundary({cwd,sdkRoot,protectedRoots:[secretRoot]}):null;
after(async()=>{await boundary?.dispose();await fs.rm(base,{recursive:true,force:true})});
const content=result=>result.content.filter(v=>v.type==='text').map(v=>v.text).join('\n');

test('native file tools run under actual sandbox and preserve diff/offset semantics',async()=>{
 await boundary.invoke('write',{path:'sample.txt',content:'one\ntwo\nthree\n'});
 const edit=await boundary.invoke('edit',{path:'sample.txt',edits:[{oldText:'two',newText:'changed'}]});
 assert.ok(edit.details.diff);
 const read=await boundary.invoke('read',{path:'sample.txt',offset:2,limit:1});
 assert.match(content(read),/changed/);assert.doesNotMatch(content(read),/one/);
});
test('file tools deny outside private paths and symlink escapes',async()=>{
 await assert.rejects(boundary.invoke('read',{path:path.join(secretRoot,'synthetic-key')}));
 await fs.symlink(secretRoot,path.join(cwd,'outside'));
 await assert.rejects(boundary.invoke('read',{path:'outside/synthetic-key'}));
 await assert.rejects(boundary.invoke('write',{path:'outside/written',content:'no'}));
 assert.equal(await fs.readFile(path.join(secretRoot,'synthetic-key'),'utf8'),'FIXTURE-PRIVATE-VALUE');
});
test('shell builds locally, streams updates and has no parent environment or private credential',async()=>{
 process.env.MANAGED_SYNTHETIC_SECRET='FIXTURE-ENV-VALUE';
 try {
  const shell=await boundary.invoke('bash',{command:'echo local-build; printf "%s" "$MANAGED_SYNTHETIC_SECRET"; cat "'+path.join(secretRoot,'synthetic-key')+'" || true',timeout:5});
  assert.match(content(shell),/local-build/);assert.doesNotMatch(content(shell),/FIXTURE-(ENV|PRIVATE)-VALUE/);
 }finally{delete process.env.MANAGED_SYNTHETIC_SECRET}
});
test('cancellation fails closed and the queue remains usable',async()=>{
 const controller=new AbortController();
 const job=boundary.invoke('bash',{command:'sleep 15',timeout:20},controller.signal);
 setTimeout(()=>controller.abort(),200);
 await assert.rejects(job,/cancelled/);
 assert.match(content(await boundary.invoke('read',{path:'sample.txt'})),/changed/);
});
test('project resources never load and custom tool ownership survives SDK reload',async()=>{
 await fs.mkdir(path.join(cwd,'.pi/extensions'),{recursive:true});
 await fs.writeFile(path.join(cwd,'.pi/extensions/hostile.mjs'),'throw new Error("PROJECT-CODE-RAN")');
 await fs.writeFile(path.join(cwd,'.pi/SYSTEM.md'),'REPLACE-COMPANY-POLICY');
 const loader=managedResourceLoader(api,{systemPrompt:'Company policy fixture'});
 assert.deepEqual(loader.getAgentsFiles(),{agentsFiles:[]});assert.deepEqual(loader.getExtensions().extensions,[]);
 assert.throws(()=>loader.extendResources({}),/disabled/);
 const {getModel}=await import(pathToFileURL(path.join(sdkRoot,'node_modules/@earendil-works/pi-ai/dist/compat.js')).href);
 const agentDir=path.join(base,'session');await fs.mkdir(agentDir);
 const {session}=await api.createAgentSession({cwd,agentDir,model:getModel('anthropic','claude-sonnet-4-5'),resourceLoader:loader,
  tools:boundary.allowed,customTools:boundary.tools(api),sessionManager:api.SessionManager.inMemory(cwd),
  settingsManager:api.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'})});
 try{
  for(let i=0;i<2;i++){
   assert.deepEqual(session.getActiveToolNames().sort(),[...boundary.allowed].sort());
   const tool=session.agent.state.tools.find(t=>t.name==='read');
   await assert.rejects(tool.execute('fixture',{path:path.join(secretRoot,'synthetic-key')},new AbortController().signal));
   await session.reload();
  }
 }finally{session.dispose()}
});

test('shell cannot link private credentials into the worktree or inspect the parent process', async () => {
 const quoted = x => "'" + x.replaceAll("'", "'\"'\"'") + "'";
 const result = await boundary.invoke('bash', {command: `ln ${quoted(path.join(secretRoot,'synthetic-key'))} linked 2>/dev/null; cat linked 2>/dev/null; /bin/ps eww -p ${process.pid} 2>/dev/null; true`, timeout:5});
 assert.doesNotMatch(content(result), /FIXTURE-PRIVATE-VALUE|MANAGED_SYNTHETIC_SECRET/);
 try { await fs.access(path.join(cwd,'linked')); assert.fail('credential hard link escaped'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
});
test('workers cannot connect to loopback or a same-user Unix credential socket', async () => {
 const socket = path.join('/tmp', 'managed-fixture-' + process.pid + '.sock'); let contacts = 0;
 const tcp = net.createServer(c => { contacts++; c.end('FIXTURE-BROKER-TOKEN'); });
 const unix = net.createServer(c => { contacts++; c.end('FIXTURE-BROKER-TOKEN'); });
 await new Promise(r=>tcp.listen(0,'127.0.0.1',r)); await new Promise(r=>unix.listen(socket,r));
 const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
 try {
  for (const target of [{host:'127.0.0.1',port:tcp.address().port}, {path:socket}]) {
   const code = `const n=require('node:net');const s=n.connect(${JSON.stringify(target)});s.on('error',()=>process.exit(0));s.on('data',d=>process.stdout.write(d));setTimeout(()=>process.exit(2),1200);`;
   const result = await boundary.invoke('bash',{command:quote(process.execPath)+' -e '+quote(code),timeout:4});
   assert.doesNotMatch(content(result),/FIXTURE-BROKER-TOKEN/);
  }
  assert.equal(contacts,0);
 } finally { await new Promise(r=>tcp.close(r));await new Promise(r=>unix.close(r)); }
});
// Names resolve through the system resolver's socket: a command the member
// approved for network reaches it (npm resolves its registry), a plain one
// does not, and the approval opens no other Unix socket.
test('an approved network command reaches the system resolver and no other Unix socket', { skip: !fsSync.existsSync('/private/var/run/mDNSResponder') }, async () => {
 const socket = path.join('/tmp', 'managed-fixture-net-' + process.pid + '.sock'); let contacts = 0;
 const unix = net.createServer(c => { contacts++; c.end('FIXTURE-BROKER-TOKEN'); }); await new Promise(r=>unix.listen(socket,r));
 const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
 const probe = target => `const s=require('node:net').connect(${JSON.stringify(target)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('DENIED '+e.code);process.exit(0)});setTimeout(()=>process.exit(2),1200);`;
 const run = (target, network) => boundary.invoke('bash',{command:quote(process.execPath)+' -e '+quote(probe(target)),timeout:4},undefined,undefined,undefined,{network}).then(content);
 try {
  assert.match(await run({path:'/private/var/run/mDNSResponder'}, true), /CONNECTED/);
  assert.match(await run({path:'/private/var/run/mDNSResponder'}, false), /DENIED/);
  assert.match(await run({path:socket}, true), /DENIED/);
  assert.equal(contacts, 0);
 } finally { await new Promise(r=>unix.close(r)); }
});
// Credential files are hidden as well as unreadable: a tool that loads one
// when present (Vite and Next read .env.local) carries on without it instead
// of failing on a file it was shown. auth.json is a credential at the project
// root (Composer) or in a dot folder; one in the source (a translation file)
// is ordinary, and so is a committed env template.
test('credential files are hidden; a nested auth.json and env templates stay readable', async () => {
 await fs.mkdir(path.join(cwd,'src/locales/en'),{recursive:true}); await fs.mkdir(path.join(cwd,'.composer'),{recursive:true});
 const files = {'.env.local':'FIXTURE-ENV-SECRET','.env.example':'API_URL=','auth.json':'FIXTURE-ROOT-AUTH','.composer/auth.json':'FIXTURE-DOT-AUTH','src/locales/en/auth.json':'{"signIn":"Sign in"}'};
 for (const [file,value] of Object.entries(files)) await fs.writeFile(path.join(cwd,file),value);
 const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
 const code = `const fs=require('fs');for(const f of ${JSON.stringify(Object.keys(files))}){let s,r;try{fs.statSync(f);s='seen'}catch(e){s=e.code}try{r=fs.readFileSync(f,'utf8')}catch(e){r=e.code}console.log(f+' '+s+' '+r)}`;
 try {
  const out = content(await boundary.invoke('bash',{command:quote(process.execPath)+' -e '+quote(code),timeout:5}));
  for (const line of ['.env.local EPERM EPERM','.env.example seen API_URL=','auth.json EPERM EPERM','.composer/auth.json EPERM EPERM','src/locales/en/auth.json seen {"signIn":"Sign in"}'])
   assert.ok(out.split('\n').includes(line), `${line}\n${out}`);
  assert.doesNotMatch(out,/FIXTURE-/);
 } finally { for (const file of Object.keys(files)) await fs.rm(path.join(cwd,file),{force:true}); }
});
// Any command may start a server on this Mac (a test's own server, an
// end-to-end suite's app); what lies beyond this Mac needs approval. The
// sandbox cannot tell loopback from all interfaces, which the approval card
// says.
test('a command may listen on this Mac, with or without approval', async () => {
 const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
 const listen = (host, network) => boundary.invoke('bash',{command:quote(process.execPath)+' -e '+quote(`const s=require('node:net').createServer();s.on('error',e=>{console.log('${host} '+e.code);process.exit(0)});s.listen(0,'${host}',()=>{console.log('${host} LISTEN');s.close()})`),timeout:5},undefined,undefined,undefined,{network}).then(content);
 assert.match(await listen('127.0.0.1', true), /127\.0\.0\.1 LISTEN/);
 assert.match(await listen('127.0.0.1', false), /127\.0\.0\.1 LISTEN/);
});
// Playwright's Chromium against a server the command starts, with or without
// approval while no local proxy listens. Opt-in: needs a project with
// @playwright/test and its browser installed
// (PIAGENT_TEST_PLAYWRIGHT_PROJECT=<that project>).
const playwrightProject = process.env.PIAGENT_TEST_PLAYWRIGHT_PROJECT;
test('an approved network command can drive Playwright\'s Chromium against a local server', { skip: !playwrightProject, timeout: 120000 }, async () => {
 const probe = path.join(playwrightProject, '.piagent-sandbox-probe.mjs');
 await fs.writeFile(probe, "import http from 'node:http';import {chromium} from '@playwright/test';const s=http.createServer((q,r)=>r.end('<h1 id=x>sandbox ok</h1>'));await new Promise(r=>s.listen(0,'127.0.0.1',r));try{const b=await chromium.launch();const p=await b.newPage();await p.goto('http://127.0.0.1:'+s.address().port+'/');console.log('PAGE '+await p.textContent('#x'));await b.close()}finally{s.close()}\n");
 const project = new ManagedToolBoundary({ cwd: playwrightProject, sdkRoot, proxyPorts: [] });
 try {
  const run = network => project.invoke('bash',{command:'node .piagent-sandbox-probe.mjs 2>&1 | tail -3',timeout:90},undefined,undefined,undefined,{network}).then(content, error => String(error.message));
  assert.match(await run(true), /PAGE sandbox ok/);
  assert.match(await run(false), /PAGE sandbox ok/);
 } finally { await project.dispose(); await fs.rm(probe, { force: true }); }
});
