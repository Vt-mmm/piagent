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
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// A company conversation is renamed from its menu, also while its turn runs
// (owner report: the menu showed session-revision-stale and kept the old
// name), and with /name; the name survives a reload.
const sdkRoot = piSdkRoot();
test('a company conversation is renamed while idle and while its turn runs',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:90000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-rename-'))),project=path.join(root,'project');fs.mkdirSync(project);
 const requests=[];let gateway,browser,releaseSlow;
 const studio=http.createServer(async(req,res)=>{ if (req.url === "/v1/capabilities") { res.writeHead(404); res.end(); return; } // a Studio older than 0.34
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  // The second answer waits until the test has renamed the conversation.
  if(requests.length===2) await new Promise(r=>{releaseSlow=r;});
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const response={id:'resp_'+requests.length,object:'response',status:'in_progress',model:body.model,output:[]};emit({type:'response.created',response});
  const output='REPLY_'+requests.length;
  const item={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output,annotations:[]}]};
  emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});
  emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:output});
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
  const composer=page.getByPlaceholder(/Nhắn cho Piagent|Message Piagent/);
  const title=name=>page.getByRole('button',{name:new RegExp('^'+name)}).first();
  const rename=async name=>{
   // The row is drawn again when its turn ends, which closes an open menu.
   await expect(async()=>{
    if(!await page.getByRole('menuitem',{name:/^Đổi tên$|^Rename$/}).isVisible()) await page.getByRole('button',{name:/Tùy chọn cuộc trò chuyện|Chat options/}).first().click();
    await page.getByRole('menuitem',{name:/^Đổi tên$|^Rename$/}).click({timeout:2000});
   }).toPass({timeout:15000});
   await page.getByLabel(/^Tên$|^Title$/).fill(name);
   await page.getByRole('button',{name:/^Xác nhận$|^Confirm$/}).click();
   await expect(page.getByRole('heading',{name:/Đổi tên cuộc trò chuyện|Rename chat/})).toBeHidden({timeout:10000});
   await expect(title(name)).toBeVisible();
  };
  await page.getByRole('button',{name:/Cuộc trò chuyện mới|New chat/}).last().click();
  await composer.fill('hello');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  await expect(page.getByText('REPLY_1',{exact:true})).toBeVisible({timeout:20000});
  await rename('Idle name');
  await composer.fill('slow one');await page.getByRole('button',{name:/^Gửi$|^Send$/}).click();
  await expect.poll(()=>requests.length,{timeout:15000}).toBe(2);
  await rename('Running name');
  assert.equal(await page.getByText('REPLY_2',{exact:true}).count(),0,'the rename landed while the turn ran');
  releaseSlow();
  await expect(page.getByText('REPLY_2',{exact:true})).toBeVisible({timeout:20000});
  await expect(title('Running name')).toBeVisible();
  await composer.fill('/name Slash name');await composer.press('Enter');
  await expect(page.getByText('Đã đổi tên thành “Slash name”.')).toBeVisible({timeout:10000});
  await expect(title('Slash name')).toBeVisible();
  await page.reload();
  await expect(title('Slash name')).toBeVisible({timeout:15000});
 }finally{releaseSlow?.();await browser?.close();await gateway?.close();await new Promise(r=>studio.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
