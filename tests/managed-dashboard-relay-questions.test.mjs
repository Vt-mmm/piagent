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

// The main agent of a company conversation asks the member a question, and
// the member answers it in the personal dashboard: the question and the
// answer go through the company relay to the company Gateway, which runs the
// conversation in its own process. Two tabs show the same question; an
// answer that does not fit, or comes for a question no longer waiting, is
// refused with the company Gateway's reason. Studio and the broker are fixtures.
const root=path.resolve(import.meta.dirname,'..');
const expectedPiVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).peerDependencies['@earendil-works/pi-coding-agent'];
const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const QUESTIONS=[{header:'Kho',question:'Lưu giỏ hàng ở đâu?',options:[{label:'LocalStorage',description:'Mất khi đổi máy'},{label:'Server',description:'Cần API mới'}]}];

test('a company agent question is shown and answered in the personal dashboard through the relay',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:150000},async()=>{
 ensureWebUiBuild(root);
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-relay-questions-')));
 const project=path.join(temp,'shop-project'),companyAgent=path.join(temp,'company-agent'),personalAgent=path.join(temp,'personal-agent'),probe=path.join(companyAgent,'probe');
 for(const dir of [project,probe,personalAgent])fs.mkdirSync(dir,{recursive:true});
 const bodies=[];let child,personal,browser,output='';
 // Studio: a turn asking for "ASK" gets an ask_user call; once the tool
 // result is in the conversation the model says it saw the answer.
 const studio=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));bodies.push(body);
  const flat=JSON.stringify(body.messages??[]),answered=flat.includes('"tool_result"'),asking=!answered&&flat.includes('ASK');
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  emit({type:'message_start',message:{id:'m',type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}});
  if(asking){emit({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_'+randomUUID().replaceAll('-',''),name:'ask_user',input:{}}});
   emit({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({questions:QUESTIONS})}});}
  else{emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:answered?'ANSWER_SEEN':'COMPANY_OK'}});}
  emit({type:'content_block_stop',index:0});emit({type:'message_delta',delta:{stop_reason:asking?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit({type:'message_stop'});res.end();
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
  await page.getByRole('button',{name:'Cuộc trò chuyện mới'}).last().click();
  await page.getByRole('button',{name:/^Project/}).click();await page.getByRole('menuitem',{name:/shop-project/}).click();
  await page.getByRole('button',{name:/^Model:/}).click();await page.getByRole('menuitem',{name:/agent-watch-auto/}).click();
  await page.getByPlaceholder('Nhắn cho Piagent…').fill('ASK where the cart lives');await page.getByRole('button',{name:'Gửi',exact:true}).click();
  const card=(p)=>p.locator('.question-card');
  try{await expect(card(page)).toBeVisible({timeout:30000});}
  catch(error){console.log('relay diagnostics',JSON.stringify({studio:bodies.length,body:(await page.locator('body').innerText()).slice(0,2500),child:output.slice(-2000)}));throw error;}
  await expect(card(page).getByText('Lưu giỏ hàng ở đâu?')).toBeVisible();
  await expect(card(page).getByText('Khác',{exact:true})).toBeVisible();
  // The same conversation in a second tab shows the same question.
  const conversation=new URL(page.url());
  const second=await context.newPage();await second.goto(await launch());await expect(second.getByText('Gateway live',{exact:true})).toBeVisible();
  await second.getByRole('navigation').getByText(/ASK where the cart lives/).first().click();
  await expect(card(second).getByText('Lưu giỏ hàng ở đâu?')).toBeVisible({timeout:15000});
  // An answer the company Gateway refuses as not fitting: 400 through the relay.
  await second.route('**/questions/*/answer',route=>route.continue({postData:JSON.stringify({answers:[{selected:[7]}]})}));
  await card(second).getByText('Server',{exact:true}).click();await card(second).getByRole('button',{name:'Gửi câu trả lời'}).click();
  await expect(card(second).getByRole('alert')).toHaveText('Chưa gửi được câu trả lời. Thử lại.');
  await second.unroute('**/questions/*/answer');
  // An answer for a question no longer waiting: 409 through the relay.
  await second.route('**/questions/*/answer',route=>route.continue({url:route.request().url().replace(/question\.[0-9a-f-]{36}/,`question.${randomUUID()}`)}));
  await card(second).getByRole('button',{name:'Gửi câu trả lời'}).click();
  await expect(card(second).getByRole('alert')).toHaveText('Câu hỏi này đã được trả lời hoặc lượt làm việc đã dừng.');
  await second.unroute('**/questions/*/answer');
  // The member answers in the first tab with the keyboard. That tab still
  // holds the token of the session the second launch replaced in this
  // browser: the refused answer is sent again with the current one.
  await card(page).focus();await page.keyboard.press('2');await page.keyboard.press('Enter');
  await expect(page.getByText('ANSWER_SEEN',{exact:true}).first()).toBeVisible({timeout:30000});
  await expect(card(page)).toHaveCount(0);await expect(card(second)).toHaveCount(0,{timeout:15000});
  const toolResult=JSON.stringify(bodies.at(-1).messages);
  assert.match(toolResult,/The member answered:/);assert.match(toolResult,/→ 2\. Server/);
  assert.equal(new URL(page.url()).pathname,conversation.pathname,'the conversation stays in the dashboard');
  const personalSessions=path.join(personalAgent,'sessions');
  assert.equal(fs.existsSync(personalSessions)?fs.readdirSync(personalSessions,{recursive:true}).filter(f=>String(f).endsWith('.jsonl')).length:0,0,'nothing of the company conversation in the personal Pi folder');
 }finally{
  await browser?.close();await personal?.close();
  if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>{const t=setTimeout(()=>{child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(t);r();});});}
  await new Promise(r=>studio.close(r));fs.rmSync(temp,{recursive:true,force:true});
 }
});
