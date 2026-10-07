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

// A command that needs the internet is shown to the user for approval in the
// company WebUI; once allowed it runs with network (here a loopback fixture),
// and its output returns to the model.
const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
test('run_with_network asks the user in the company WebUI and runs the approved command with network',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:60000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-network-approval-'))),project=path.join(root,'project');fs.mkdirSync(project);
 const registry=http.createServer((_req,res)=>res.end('REGISTRY_REACHED'));await new Promise(r=>registry.listen(0,'127.0.0.1',r));
 const command=`curl -sS -m 5 http://127.0.0.1:${registry.address().port}/left-pad`;
 const requests=[];let gateway,browser;
 const studio=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const response={id:'resp_'+requests.length,object:'response',status:'in_progress',model:body.model,output:[]};emit({type:'response.created',response});
  let item;
  if(requests.length===1){
   const args=JSON.stringify({command,reason:'Download the package metadata'});
   item={id:'fc_net',type:'function_call',call_id:'call_net',name:'run_with_network',arguments:args,status:'completed'};
   emit({type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}});
   emit({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:args});
   emit({type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:args});
  }else{
   const output=JSON.stringify(body.input).includes('REGISTRY_REACHED')?'NETWORK_APPROVED_OK':'NETWORK_MISSING';
   item={id:'msg_net',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output,annotations:[]}]};
   emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});
   emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:output});
  }
  emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});res.end();
 });
 await new Promise(r=>studio.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},roleID=randomUUID();
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[{id:'gpt-6-sol',owned_by:'codex',provider_model_id:'gpt-6-sol'}],harness:{configuration:{main:{model_ids:['gpt-6-sol']}}}};
  const grant={...authority,run_id:randomUUID(),role_id:roleID,role:'main',fence:1,token:`as_run_${roleID}_${'x'.repeat(43)}`,model_id:'gpt-6-sol',provider_model_id:'gpt-6-sol',provider:'codex',effort:'medium'};
  const broker=path.join(root,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`,{mode:0o700});
  const config={broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${studio.address().port}`};
  const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  gateway=await startManagedGateway({config,configPath,cwd:project,agentDir:path.join(root,'agent'),packageRoot:path.resolve(import.meta.dirname,'..')});
  const launch=await requestGatewayControl(gateway.descriptor.controlSocket,{action:'issue-launch-url'});assert.equal(launch.ok,true);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({locale:'vi-VN'});await page.goto(launch.value.launchUrl);
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('Install left-pad');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  try{await expect(page.getByText(/Download the package metadata/).first()).toBeVisible({timeout:15000});}
  catch(error){console.log('approval diagnostics',JSON.stringify({requests:requests.length,body:(await page.locator('body').innerText()).slice(0,2000)}));throw error;}
  await expect(page.getByText(new RegExp(command.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&'))).first()).toBeVisible();
  assert.equal(requests.length,1,'nothing runs before approval');
  await page.getByRole('button',{name:/^Cho phép|^Allow/}).last().click();
  await expect(page.getByText('NETWORK_APPROVED_OK',{exact:true})).toBeVisible({timeout:20000});
  assert.equal(requests.length,2);
 }finally{await browser?.close();await gateway?.close();await new Promise(r=>studio.close(r));await new Promise(r=>registry.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

// Bypass: a command that needs the internet runs without asking; one that
// sends data out (git push) is still asked, with the reason.
test('Bypass runs network commands without asking but still asks before git push',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:90000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-bypass-'))),project=path.join(root,'project');fs.mkdirSync(project);
 const registry=http.createServer((_req,res)=>res.end('REGISTRY_REACHED'));await new Promise(r=>registry.listen(0,'127.0.0.1',r));
 const download=`curl -sS -m 5 http://127.0.0.1:${registry.address().port}/left-pad`,push='git push origin main';
 const requests=[];let gateway,browser;
 const call=(command,reason)=>{const args=JSON.stringify({command,reason});return {id:'fc_'+requests.length,type:'function_call',call_id:'call_'+requests.length,name:'run_with_network',arguments:args,status:'completed'};};
 const studio=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const response={id:'resp_'+requests.length,object:'response',status:'in_progress',model:body.model,output:[]};emit({type:'response.created',response});
  let item;
  if(requests.length<=2){
   item=requests.length===1?call(download,'Download the package metadata'):call(push,'Publish the branch');
   emit({type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}});
   emit({type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments});
  }else{
   item={id:'msg_net',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'BYPASS_DONE',annotations:[]}]};
   emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});
   emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'BYPASS_DONE'});
  }
  emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});res.end();
 });
 await new Promise(r=>studio.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},roleID=randomUUID();
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[{id:'gpt-6-sol',owned_by:'codex',provider_model_id:'gpt-6-sol'}],harness:{configuration:{main:{model_ids:['gpt-6-sol']}}}};
  const grant={...authority,run_id:randomUUID(),role_id:roleID,role:'main',fence:1,token:`as_run_${roleID}_${'x'.repeat(43)}`,model_id:'gpt-6-sol',provider_model_id:'gpt-6-sol',provider:'codex',effort:'medium'};
  const broker=path.join(root,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`,{mode:0o700});
  const config={broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${studio.address().port}`};
  const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  gateway=await startManagedGateway({config,configPath,cwd:project,agentDir:path.join(root,'agent'),packageRoot:path.resolve(import.meta.dirname,'..')});
  const launch=await requestGatewayControl(gateway.descriptor.controlSocket,{action:'issue-launch-url'});assert.equal(launch.ok,true);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({locale:'vi-VN'});await page.goto(launch.value.launchUrl);
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await page.getByRole('button',{name:/Thêm tùy chọn|More options/}).click();
  await page.getByRole('button',{name:/^Hỏi trước$|^Ask first$/}).click();
  await page.getByRole('menuitem',{name:/Bypass/}).click();
  await page.getByRole('button',{name:/^Dùng Bypass$|^Use Bypass$/}).click();
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('Install left-pad and push');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  // The download ran without asking; the push waits for the member.
  try{await expect(page.getByText(/Bypass still asks/).first()).toBeVisible({timeout:20000});}
  catch(error){console.log('bypass diagnostics',JSON.stringify({requests:requests.length,body:(await page.locator('body').innerText()).slice(0,2000)}));throw error;}
  assert.equal(requests.length,2,'the download ran without an approval');
  assert.match(JSON.stringify(requests[1].input),/REGISTRY_REACHED/);
  await page.getByRole('button',{name:/^Từ chối|^Deny/}).last().click();
  await expect(page.getByText('BYPASS_DONE',{exact:true})).toBeVisible({timeout:20000});
  // The choice is kept with the conversation.
  await expect(page.getByRole('button',{name:/Đổi quyền truy cập|Change access level/})).toHaveText(/Bypass/);
 }finally{await browser?.close();await gateway?.close();await new Promise(r=>studio.close(r));await new Promise(r=>registry.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
