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
import {ensureWebUiBuild} from './helpers/piagent-webui-build.mjs';

// Several things wait for the member: inside one conversation the questions
// and approvals come one card at a time (the main agent's first), and what
// happens in the other conversations (a question, a finished turn) shows as a
// toast at the top right and a mark in the sidebar. Studio and the broker are
// fixtures; the company Gateway runs the conversations as in production.
const root=path.resolve(import.meta.dirname,'..');
const expectedPiVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).peerDependencies['@earendil-works/pi-coding-agent'];
const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const Q_STORE=[{header:'Kho',question:'Lưu giỏ hàng ở đâu?',options:[{label:'LocalStorage',description:'Mất khi đổi máy'},{label:'Server',description:'Cần API mới'}]}];
const Q_COLOR=[{header:'Màu',question:'Màu nút chính?',options:[{label:'Xanh'},{label:'Đỏ'}]}];

test('questions come one at a time and other conversations announce what they need',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:240000},async()=>{
 ensureWebUiBuild(root);
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-attention-')));
 const project=path.join(temp,'shop-project'),companyAgent=path.join(temp,'company-agent'),personalAgent=path.join(temp,'personal-agent'),probe=path.join(companyAgent,'probe');
 for(const dir of [project,probe,personalAgent])fs.mkdirSync(dir,{recursive:true});
 const bodies=[];let child,personal,browser,output='';
// Studio: "ASK2" gets two ask_user calls in one answer (Pi runs them side
 // by side, so both wait at once); "LATER" answers after a pause; "ASKLATER"
 // asks after that pause; once the tool results are in, the model says so.
 const studio=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));bodies.push(body);
  const flat=JSON.stringify(body.messages??[]),answered=flat.includes('"tool_result"');
  const two=!answered&&flat.includes('ASK2'),one=!answered&&flat.includes('ASKLATER');
  if(flat.includes('LATER')&&!answered)await new Promise(r=>setTimeout(r,4000));
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  emit({type:'message_start',message:{id:'m',type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});
  const asks=two?[Q_STORE,Q_COLOR]:one?[Q_STORE]:[];
  asks.forEach((questions,index)=>{emit({type:'content_block_start',index,content_block:{type:'tool_use',id:'toolu_'+randomUUID().replaceAll('-',''),name:'ask_user',input:{}}});
   emit({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify({questions})}});emit({type:'content_block_stop',index});});
  if(!asks.length){emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:answered?'ANSWER_SEEN':'LATER_DONE'}});emit({type:'content_block_stop',index:0});}
  emit({type:'message_delta',delta:{stop_reason:asks.length?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit({type:'message_stop'});res.end();
 });
 await new Promise(r=>studio.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},roleID=randomUUID();
  const model={id:'claude-sonnet-5-5',owned_by:'claude',provider_model_id:'claude-sonnet-5-5'};
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[model],harness:{configuration:{main:{model_ids:[model.id]}}}};
  const grant={...authority,run_id:randomUUID(),role_id:roleID,role:'main',fence:1,token:`as_run_${roleID}_${'x'.repeat(43)}`,model_id:model.id,provider_model_id:model.provider_model_id,provider:'claude',effort:'medium'};
  const broker=path.join(temp,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`,{mode:0o700});
  const configPath=path.join(temp,'binding.json');
  fs.writeFileSync(configPath,JSON.stringify({broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${studio.address().port}`}));
  const script=path.join(temp,'company-gateway.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';
const [configPath,agentDir,probe]=process.argv.slice(2);
await import(${JSON.stringify(pathToFileURL(path.join(root,'scripts/register-typescript-loader.mjs')).href)});
const {startManagedGateway}=await import(${JSON.stringify(pathToFileURL(path.join(root,'packages/piagent-webui/gateway/managed-gateway.mjs')).href)});
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const gateway=await startManagedGateway({config,configPath,cwd:probe,agentDir,packageRoot:${JSON.stringify(root)},registerProject:false});
process.stdout.write('ready\\n');process.once('SIGTERM',()=>void gateway.close());await gateway.wait();`);
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',script,configPath,companyAgent,probe],{stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('company gateway start: '+output)),40000);
   child.stdout.on('data',()=>{if(output.includes('ready')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('company gateway exited: '+output));});});
  const socket=gatewayProfileState(companyAgent).controlSocket;
  personal=await startPiagentGateway({packageRoot:root,expectedPiVersion,agentDir:personalAgent,company:{configured:()=>true,ensure:async()=>socket,attach:async()=>socket}});
  assert.equal((await requestGatewayControl(socket,{action:'project.register',cwd:project})).ok,true);
  const launch=async()=>{const issued=await requestGatewayControl(gatewayProfileState(personalAgent).controlSocket,{action:'issue-launch-url'});assert.equal(issued.ok,true);return issued.value.launchUrl;};
  browser=await chromium.launch({headless:true});const context=await browser.newContext({locale:'vi-VN'});
  const page=await context.newPage();await page.goto(await launch());
  await expect(page.getByText('Gateway live',{exact:true})).toBeVisible();
  const newChat=async(text)=>{
   await page.getByRole('button',{name:'Cuộc trò chuyện mới'}).last().click();
   await page.getByRole('button',{name:/^Project/}).click();await page.getByRole('menuitem',{name:/shop-project/}).click();
   await page.getByRole('button',{name:/^Model:/}).click();await page.getByRole('menuitem',{name:/agent-watch-auto/}).click();
   await page.getByPlaceholder('Nhắn cho Piagent…').fill(text);await page.getByRole('button',{name:'Gửi',exact:true}).click();
  };
  const card=page.locator('.question-card'),steps=page.locator('.decision-steps'),toasts=page.locator('.attention-toast');
  // Two questions at once: one card, the steps say 1/2, the main agent's first asked first.
  await newChat('ASK2 cart and colour');
  await expect(steps).toContainText('Việc cần bạn quyết · 1/2',{timeout:30000});
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Main agent cần bạn quyết định');
  // Phone to 4K: the steps and the card fit, nothing scrolls sideways.
  const shots=process.env.PIAGENT_TEST_SHOTS;
  for(const [width,height] of [[390,844],[768,1024],[1440,900],[3840,2160]]){
   await page.setViewportSize({width,height});await page.reload();await expect(card).toContainText('Lưu giỏ hàng ở đâu?',{timeout:15000});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no sideways scroll at ${width}px`);
   const c=await card.boundingBox();assert.ok(c.x>=0&&c.x+c.width<=width+1,`card fits at ${width}px`);
   const steps=await page.locator('.decision-steps').boundingBox();assert.ok(steps.x>=0&&steps.x+steps.width<=width+1,`steps fit at ${width}px`);
   if(shots)await page.screenshot({path:`${shots}/queue-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:900});
  await expect(card).toContainText('Lưu giỏ hàng ở đâu?');
  // A step picks the other one; answering it brings the remaining one back.
  await steps.getByRole('button').nth(1).click();
  await expect(card).toContainText('Màu nút chính?');await expect(steps).toContainText('2/2');
  await card.focus();await page.keyboard.press('1');await page.keyboard.press('Enter');
  await expect(card).toContainText('Lưu giỏ hàng ở đâu?');await expect(steps).toHaveCount(0);
  await card.focus();await page.keyboard.press('2');await page.keyboard.press('Enter');
  await expect(page.getByText('ANSWER_SEEN',{exact:true}).first()).toBeVisible({timeout:30000});
  await expect(card).toHaveCount(0);
  const nav=page.getByRole('navigation');
  // Another conversation asks while this one is on screen: a toast at the top
  // right, the conversation marked in the sidebar, the tab title counts it.
  // The new conversation is created and opened first; the model asks 4 s later.
  const opened=async(title)=>expect(page.getByRole('banner').getByRole('heading',{name:title})).toBeVisible({timeout:15000});
  await newChat('ASKLATER the store');await opened('ASKLATER the store');
  await expect(page.getByRole('status').filter({hasText:/đang/i}).first()).toBeVisible();
  await nav.getByText(/ASK2 cart and colour/).first().click();await opened('ASK2 cart and colour');
  await expect(toasts.filter({hasText:'Cần bạn trả lời'})).toBeVisible({timeout:30000});
  await expect(toasts.filter({hasText:'Cần bạn trả lời'})).toContainText('ASKLATER the store');
  await expect(page.locator('.session-item.attention').first()).toContainText('Cần bạn trả lời');
  await expect.poll(()=>page.title()).toMatch(/^\(1\) /);
  const box=await toasts.first().boundingBox(),width=page.viewportSize().width;
  assert.ok(box.x+box.width>width-40&&box.y<120,'toast at the top right');
  for(const [w,h] of [[390,844],[3840,2160]]){
   await page.setViewportSize({width:w,height:h});const t=await toasts.first().boundingBox();
   assert.ok(t.x>=0&&t.x+t.width<=w&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`toast fits at ${w}px`);
   if(process.env.PIAGENT_TEST_SHOTS)await page.screenshot({path:`${process.env.PIAGENT_TEST_SHOTS}/toast-${w}.png`});
  }
  await page.setViewportSize({width:1440,height:900});
  await expect(page.locator('.session-item.attention').first().getByRole('img',{name:'Cần bạn trả lời'})).toBeVisible();
  await toasts.filter({hasText:'Cần bạn trả lời'}).getByRole('button',{name:'Mở'}).click();await opened('ASKLATER the store');
  await expect(card).toContainText('Lưu giỏ hàng ở đâu?');await expect(toasts).toHaveCount(0);
  await card.focus();await page.keyboard.press('1');await page.keyboard.press('Enter');
  await expect(page.getByText('ANSWER_SEEN',{exact:true}).first()).toBeVisible({timeout:30000});
  await expect.poll(()=>page.title()).not.toMatch(/^\(\d+\) /);
  // A turn that ends in another conversation: a "Xong" toast and a mark until opened.
  await newChat('LATER please');await opened('LATER please');
  await nav.getByText(/ASK2 cart and colour/).first().click();await opened('ASK2 cart and colour');
  await expect(toasts.filter({hasText:'Xong · LATER please'})).toBeVisible({timeout:30000});
  await expect(page.locator('.session-item.fresh').filter({hasText:'LATER please'}).first()).toContainText('Xong · chưa xem');
  await nav.getByText(/LATER please/).first().click();await opened('LATER please');
  await expect(page.locator('.session-item.fresh').filter({hasText:'LATER please'})).toHaveCount(0);
  await expect(page.getByText('LATER_DONE',{exact:true}).first()).toBeVisible();
  }finally{
  await browser?.close();await personal?.close();
  if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{const t=setTimeout(()=>{child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(t);r();});});}
  await new Promise(r=>studio.close(r));fs.rmSync(temp,{recursive:true,force:true});
 }
});
