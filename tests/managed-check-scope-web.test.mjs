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
import { ensureWebUiBuild } from './helpers/piagent-webui-build.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// The harness's own questions reach the member on the dashboard, with no ask_user step running.
const sdkRoot = piSdkRoot();

test('the dashboard shows the harness\'s own questions: before a whole suite and before a push',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:90000},async()=>{
 ensureWebUiBuild(path.resolve(import.meta.dirname,'..'));
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-scope-'))),project=path.join(root,'project');fs.mkdirSync(project);
 const requests=[];let gateway,browser;
 const call=(command,reason)=>{const args=JSON.stringify({command});return {id:'fc_'+requests.length,type:'function_call',call_id:'call_'+requests.length,name:'bash',arguments:args,status:'completed'};};
 const studio=http.createServer(async(req,res)=>{ if (req.url === "/v1/capabilities") { res.writeHead(404); res.end(); return; } // a Studio older than 0.34
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const response={id:'resp_'+requests.length,object:'response',status:'in_progress',model:body.model,output:[]};emit({type:'response.created',response});
  let item;
  // Another request of the turn (a title) has no tools and takes no step of the script.
  const said=JSON.stringify(body.input??''),step=!body.tools?.length?null:!said.includes('function_call')?'npm test':!said.includes('git push')?'git push origin main':null;
  if(step){
   item=call(step);
   emit({type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}});
   emit({type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments});
  }else{
   item={id:'msg_net',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'SCOPE_DONE',annotations:[]}]};
   emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});
   emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
   emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'SCOPE_DONE'});
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
  await page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/).fill('Install left-pad and push');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  // No ask_user step is running here: the card still appears, for a whole suite and then for a push.
  await expect(page.locator('.question-card').getByText(/Agent muốn chạy toàn bộ test/)).toBeVisible({timeout:30000});
  await page.locator('.question-card').focus();await page.keyboard.press('1');await page.keyboard.press('Enter');
  await expect(page.locator('.question-card').getByText(/Sắp push code/)).toBeVisible({timeout:30000});
  assert.match(JSON.stringify(requests.at(-1).input),/managed-check-scope/);
  await page.locator('.question-card').focus();await page.keyboard.press('2');await page.keyboard.press('Enter');
  await expect(page.getByText('SCOPE_DONE',{exact:true})).toBeVisible({timeout:30000});
 }finally{await browser?.close();await gateway?.close();await new Promise(r=>studio.close(r));fs.rmSync(root,{recursive:true,force:true});}
});

