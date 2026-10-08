import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';
import '../scripts/register-typescript-loader.mjs';
import {startManagedGateway} from '../packages/piagent-webui/gateway/managed-gateway.mjs';
import {requestGatewayControl} from '../packages/piagent-webui/gateway/control-socket.ts';

// Studio refusing a turn (here the connector's 503) must end the turn in the
// company WebUI with a visible reason, and the next message must still go out.
const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
test('managed WebUI shows a Studio refusal instead of an endless wait and accepts the next message', {skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:60000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-inference-error-'))),project=path.join(root,'project');fs.mkdirSync(project);
 const requests=[];let gateway,browser;
 const server=http.createServer(async(req,res)=>{
  for await(const _ of req);requests.push(req.url);
  res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'connector_unavailable',message:'connector_unavailable',request_id:randomUUID()}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},roleID=randomUUID();
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[{id:'claude-opus-5-5',owned_by:'claude',provider_model_id:'claude-opus-5-5'}],harness:{configuration:{main:{model_ids:['claude-opus-5-5']}}}};
  const grant={...authority,run_id:randomUUID(),role_id:roleID,role:'main',fence:1,token:`as_run_${roleID}_${'x'.repeat(43)}`,model_id:'claude-opus-5-5',provider_model_id:'claude-opus-5-5',provider:'claude',effort:'high'};
  const broker=path.join(root,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`,{mode:0o700});
  const config={broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${server.address().port}`};
  const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  gateway=await startManagedGateway({config,configPath,cwd:project,agentDir:path.join(root,'agent'),packageRoot:path.resolve(import.meta.dirname,'..')});
  const launch=await requestGatewayControl(gateway.descriptor.controlSocket,{action:'issue-launch-url'});assert.equal(launch.ok,true);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({locale:'vi-VN'});await page.goto(launch.value.launchUrl);
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('hello em');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  // Who failed (a harness role, never the model), what kind, what to do, and the code an administrator needs.
  const refusal=/Main agent lỗi · Dịch vụ model lỗi/;
  // A passing service failure is asked again twice (2 s, then 4 s) before it is shown.
  await expect.poll(()=>requests.length,{timeout:20000}).toBe(3);
  await expect(page.getByText(refusal).first()).toBeVisible({timeout:15000});
  await expect(page.getByText(/Studio đã nhận yêu cầu nhưng dịch vụ model phía sau không trả lời/).first()).toBeVisible();
  await expect(page.getByText(/^Mã: connector_unavailable · request [0-9a-f]{8}$/).first()).toBeVisible();
  await expect(page.getByText(/3 request/).first()).toBeVisible();
  assert.doesNotMatch(await page.locator('body').innerText(),/claude-opus|opus-5/i);
  const composer=page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).last();
  await composer.fill('thử lại');await composer.press('Enter');
  await expect.poll(()=>requests.length,{timeout:20000}).toBe(6);
  await expect(page.getByText('thử lại',{exact:true}).first()).toBeVisible();
  await expect(page.getByText(refusal)).toHaveCount(2,{timeout:15000});
  assert.equal(requests.length,6,'two retries for each message, no more');
 }finally{await browser?.close();await gateway?.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

// A helper that Studio refuses: its step says which subagent failed and why,
// the main agent still answers, and no model name reaches the page.
test('managed WebUI shows why a subagent failed on its step', {skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:60000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-helper-error-'))),project=path.join(root,'project');fs.mkdirSync(project);
 const roles={main:randomUUID(),research:randomUUID()};let gateway,browser,mainRequests=0;
 const server=http.createServer(async(req,res)=>{
  for await(const _ of req);
  if(req.headers['x-session-id']===roles.research){res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'token_quota_exhausted',message:'token_quota_exhausted',request_id:randomUUID()}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  emit({type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',content:[],model:'claude-opus-5-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:12,output_tokens:0}}});
  if(++mainRequests===1){
   emit({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:'delegate',input:{}}});
   emit({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({role:'research',task:'Find the documentation'})}});
   emit({type:'content_block_stop',index:0});emit({type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:9}});
  }else{
   emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ANSWER_WITHOUT_HELPER'}});
   emit({type:'content_block_stop',index:0});emit({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});
  }
  emit({type:'message_stop'});res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},run=randomUUID();
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[{id:'claude-opus-5-5',owned_by:'claude',provider_model_id:'claude-opus-5-5'}],harness:{configuration:{main:{model_ids:['claude-opus-5-5']},research:{model_ids:['claude-opus-5-5']}}}};
  const grant={...authority,run_id:run,fence:1,model_id:'claude-opus-5-5',provider_model_id:'claude-opus-5-5',provider:'claude',effort:'high'};
  const broker=path.join(root,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';let fence=0;const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)},roles=${JSON.stringify(roles)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line),role=q.role||'main';process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...grant,fence:++fence,role,role_id:roles[role],token:'as_run_'+roles[role]+'_'+'x'.repeat(43)}})+'\\n');}`,{mode:0o700});
  const config={broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${server.address().port}`};
  const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  gateway=await startManagedGateway({config,configPath,cwd:project,agentDir:path.join(root,'agent'),packageRoot:path.resolve(import.meta.dirname,'..')});
  const launch=await requestGatewayControl(gateway.descriptor.controlSocket,{action:'issue-launch-url'});assert.equal(launch.ok,true);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({locale:'vi-VN'});await page.goto(launch.value.launchUrl);
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('Research this');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  await expect(page.getByText('ANSWER_WITHOUT_HELPER',{exact:true}).first()).toBeVisible({timeout:20000});
  await expect(page.getByText('Subagent research lỗi · Hết hạn mức token').first()).toBeVisible({timeout:15000});
  await expect(page.getByText(/^Mã: token_quota_exhausted · request [0-9a-f]{8}$/).first()).toBeVisible();
  await expect(page.getByText(/2 request/).first()).toBeVisible();
  const body=await page.locator('body').innerText();
  assert.doesNotMatch(body,/claude-opus|opus-5/i);assert.doesNotMatch(body,/Find the documentation.*managed-helper-failed/s);
 }finally{await browser?.close();await gateway?.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
