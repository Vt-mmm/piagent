import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';
import '../scripts/register-typescript-loader.mjs';
import {startManagedGateway} from '../packages/piagent-webui/gateway/managed-gateway.mjs';
import {requestGatewayControl} from '../packages/piagent-webui/gateway/control-socket.ts';
import {piApprovalBroker} from '../packages/piagent-core/runtime/inspection/approval-broker.ts';

const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
test('managed WebUI presents a scoped Git operation; denial resumes chat without fetching', {skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:120000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-operation-web-'))),project=path.join(root,'project');fs.mkdirSync(project);
 execFileSync('/usr/bin/git',['init','-q',project]);execFileSync('/usr/bin/git',['-C',project,'remote','add','origin','git@github.com:fixture/approval-test.git']);
 const requests=[];let gateway,browser;const diagnostics=[];
 const originalRequest=piApprovalBroker.request.bind(piApprovalBroker);
 piApprovalBroker.request=(args)=>{diagnostics.push(piApprovalBroker.projection(args.cwd,args.rawSessionId));const result=originalRequest(args);diagnostics.push(piApprovalBroker.projection(args.cwd,args.rawSessionId));return result;};
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const response={id:'resp_fixture_'+requests.length,object:'response',status:'in_progress',model:body.model,output:[]};emit({type:'response.created',response});
  let item;
  if(requests.length===1){
   item={id:'fc_fixture',type:'function_call',call_id:'call_fetch',name:'fetch_origin',arguments:'{}',status:'completed'};
   emit({type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}});
   emit({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:'{}'});
   emit({type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:'{}'});
  }else{
   item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'FETCH_DENIED_OK',annotations:[]}]};
   emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});
   emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'FETCH_DENIED_OK'});
  }
  emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});res.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},runID=randomUUID(),roleID=randomUUID();
  const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:randomUUID(),models:[{id:'gpt-6-sol',owned_by:'codex',provider_model_id:'gpt-6-sol'}],harness:{configuration:{main:{model_ids:['gpt-6-sol']},research:{model_ids:['gpt-6-sol']},review:{model_ids:['gpt-6-sol']}}}};
  const grant={...authority,run_id:runID,role_id:roleID,role:'main',fence:1,token:`as_run_${roleID}_${'x'.repeat(43)}`,model_id:'gpt-6-sol',provider_model_id:'gpt-6-sol',provider:'codex',effort:'medium'};
  const broker=path.join(root,'broker');fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`,{mode:0o700});
  const config={broker,profile_id:'a'.repeat(64),sdk_root:sdkRoot,origin:`http://127.0.0.1:${server.address().port}`};
  const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  gateway=await startManagedGateway({config,configPath,cwd:project,agentDir:path.join(root,'agent'),packageRoot:path.resolve(import.meta.dirname,'..')});
  const launch=await requestGatewayControl(gateway.descriptor.controlSocket,{action:'issue-launch-url'});assert.equal(launch.ok,true);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({locale:'en-US'});await page.goto(launch.value.launchUrl);
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('Fetch the origin branches');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  try{await expect(page.getByText(/fixture\/approval-test/).first()).toBeVisible({timeout:15000});}
  catch(error){console.log('operation diagnostics',JSON.stringify({requests:requests.length,diagnostics,body:await page.locator('body').innerText()}));throw error;}
  const deny=page.getByRole('button',{name:/^Deny$|^Từ chối$/}).last();await expect(deny).toBeVisible();await deny.click();
  await expect(page.getByText('FETCH_DENIED_OK',{exact:true})).toBeVisible({timeout:15000});
  await expect(page.getByText(/^(Subagent|Subagents) 0\/2$/)).toBeVisible();
  await expect(page.getByRole('button',{name:/agent-watch-auto.*Thinking|agent-watch-auto.*thinking|agent-watch-auto.*high/i}).first()).toBeVisible();
  await page.getByRole('button',{name:/agent-watch-auto.*Thinking/i}).first().click();
  await page.getByRole('combobox',{name:'Thinking',exact:true}).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  assert.equal(requests.length,2);assert.match(JSON.stringify(requests[1]),/managed-operation-denied/);
  assert.equal(fs.existsSync(path.join(project,'.git/FETCH_HEAD')),false);
 }finally{piApprovalBroker.request=originalRequest;await browser?.close();await gateway?.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
