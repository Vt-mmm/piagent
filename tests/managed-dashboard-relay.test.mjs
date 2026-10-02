import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';
import '../scripts/register-typescript-loader.mjs';
import {startPiagentGateway} from '../packages/piagent-webui/gateway/gateway-service.ts';
import {requestGatewayControl} from '../packages/piagent-webui/gateway/control-socket.ts';
import {gatewayProfileState} from '../packages/piagent-webui/gateway/profile-state.ts';
import {loadPinnedPiHost} from '../packages/piagent-webui/gateway/pi-host.ts';
import {ensureWebUiBuild} from './helpers/piagent-webui-build.mjs';

// The personal dashboard shows a company session in its own list and page:
// the company Gateway runs in its own process (as `piagent studio --serve`
// does) and the dashboard relays to it. Studio and the broker are fixtures.
const root=path.resolve(import.meta.dirname,'..');
const expectedPiVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).peerDependencies['@earendil-works/pi-coding-agent'];
const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const assistant=(text)=>({role:'assistant',content:[{type:'text',text}],api:'fixture',provider:'fixture',model:'fixture',
 usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});

test('a company session is created, answered and listed inside the personal dashboard',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:120000},async()=>{
 ensureWebUiBuild(root);
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-dashboard-relay-')));
 const project=path.join(temp,'shop-project'),companyAgent=path.join(temp,'company-agent'),personalAgent=path.join(temp,'personal-agent'),probe=path.join(companyAgent,'probe');
 for(const dir of [project,probe,personalAgent])fs.mkdirSync(dir,{recursive:true});
 const requests=[];let child,personal,browser;
 const studio=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const response={id:'resp_fixture',object:'response',status:'in_progress',model:body.model,output:[]};emit({type:'response.created',response});
  const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'COMPANY_OK',annotations:[]}]};
  emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});
  emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'COMPANY_OK'});
  emit({type:'response.output_item.done',output_index:0,item});
  emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});res.end();
 });
 await new Promise(r=>studio.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},roleID=randomUUID();
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[{id:'gpt-6-sol',owned_by:'codex',provider_model_id:'gpt-6-sol'}],harness:{configuration:{main:{model_ids:['gpt-6-sol']}}}};
  const grant={...authority,run_id:randomUUID(),role_id:roleID,role:'main',fence:1,token:`as_run_${roleID}_${'x'.repeat(43)}`,model_id:'gpt-6-sol',provider_model_id:'gpt-6-sol',provider:'codex',effort:'medium'};
  const broker=path.join(temp,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`,{mode:0o700});
  const configPath=path.join(temp,'binding.json');
  fs.writeFileSync(configPath,JSON.stringify({broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${studio.address().port}`}));
  // The company Gateway in its own process, like `piagent studio --serve`.
  const script=path.join(temp,'company-gateway.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';
const [configPath,agentDir,probe]=process.argv.slice(2);
await import(${JSON.stringify(pathToFileURL(path.join(root,'scripts/register-typescript-loader.mjs')).href)});
const {startManagedGateway}=await import(${JSON.stringify(pathToFileURL(path.join(root,'packages/piagent-webui/gateway/managed-gateway.mjs')).href)});
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const gateway=await startManagedGateway({config,configPath,cwd:probe,agentDir,packageRoot:${JSON.stringify(root)},registerProject:false});
process.stdout.write('ready\\n');process.once('SIGTERM',()=>void gateway.close());await gateway.wait();`);
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',script,configPath,companyAgent,probe],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('company gateway start: '+output)),40000);
   child.stdout.on('data',()=>{if(output.includes('ready')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('company gateway exited: '+output));});});
  const socket=gatewayProfileState(companyAgent).controlSocket;
  personal=await startPiagentGateway({packageRoot:root,expectedPiVersion,agentDir:personalAgent,company:{configured:()=>true,ensure:async()=>socket,attach:async()=>socket}});
  // One personal conversation in the project, so both groups are visible.
  const host=await loadPinnedPiHost(expectedPiVersion);
  const manager=host.SessionManager.create(project,undefined);
  manager.appendMessage({role:'user',content:[{type:'text',text:'Personal question'}],timestamp:Date.now()});manager.appendMessage(assistant('Personal answer'));
  const launch=await requestGatewayControl(gatewayProfileState(personalAgent).controlSocket,{action:'issue-launch-url'});assert.equal(launch.ok,true);
  const origin=new URL(launch.value.launchUrl).origin;
  browser=await chromium.launch({headless:true});const page=await browser.newPage({locale:'vi-VN'});await page.goto(launch.value.launchUrl);
  await expect(page.getByText('Gateway live',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cuộc trò chuyện mới'}).last().click();
  await expect(page.getByRole('main').getByRole('button',{name:/shop-project/})).toBeVisible();
  await page.getByRole('button',{name:/^Model:/}).click();
  await expect(page.getByRole('menu').getByText('Công ty',{exact:true})).toBeVisible();
  await page.getByRole('menuitem',{name:/agent-watch-auto/}).click();
  await expect(page.getByRole('button',{name:'Model: Công ty · agent-watch-auto'})).toBeVisible();
  await page.getByPlaceholder('Nhắn cho Piagent…').fill('hello company');await page.getByRole('button',{name:'Gửi',exact:true}).click();
  try{await expect(page.getByText('COMPANY_OK',{exact:true}).first()).toBeVisible({timeout:30000});}
  catch(error){console.log('relay diagnostics',JSON.stringify({studio:requests.length,body:(await page.locator('body').innerText()).slice(0,2500),child:output.slice(-2000)}));throw error;}
  assert.equal(new URL(page.url()).origin,origin,'the conversation stays in the dashboard');
  assert.equal(browser.contexts()[0].pages().length,1,'no second tab');
  await expect(page.getByRole('navigation').getByText(/^Công ty/).first()).toBeVisible();
  await expect(page.getByRole('navigation').getByText('Personal question').first()).toBeVisible();
  assert.equal(requests.length,1,'one company turn reached Studio');
  const companySessions=fs.readdirSync(path.join(companyAgent,'sessions'),{recursive:true}).filter(f=>String(f).endsWith('.jsonl'));
  assert.equal(companySessions.length,1,'the company transcript lives with the company runtime');
  const personalSessions=fs.readdirSync(path.join(personalAgent,'sessions'),{recursive:true}).filter(f=>String(f).endsWith('.jsonl'));
  assert.equal(personalSessions.length,1,'no company transcript in the personal Pi folder');
  // A folder known only to the company runtime (opened from Agent Watch) is
  // offered for new chats in the dashboard too.
  const companyOnly=path.join(temp,'company-only');fs.mkdirSync(companyOnly);
  assert.equal((await requestGatewayControl(socket,{action:'project.register',cwd:companyOnly})).ok,true);
  await page.getByRole('button',{name:'Cuộc trò chuyện mới'}).last().click();
  await page.getByRole('button',{name:/^Project/}).click();
  await expect(page.getByRole('menuitem',{name:/company-only/})).toBeVisible({timeout:15000});
 }finally{
  await browser?.close();await personal?.close();
  if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{const t=setTimeout(()=>{child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(t);r();});});}
  await new Promise(r=>studio.close(r));fs.rmSync(temp,{recursive:true,force:true});
 }
});
