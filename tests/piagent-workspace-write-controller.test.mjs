import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { WorkspaceWriteController, workspaceWriteDigest } from '../packages/piagent-webui/server/workspace-write-controller.ts';
import { writeWorkspaceFile } from '../packages/piagent-core/extensions/workspace-write.ts';
import { createWebUiSchemaRegistry, validateFixture } from './helpers/piagent-webui-schema-registry.mjs';
const registry=createWebUiSchemaRegistry(), sha=text=>createHash('sha256').update(text).digest('hex');
function valid(value) { const result=validateFixture(registry,'workspace-write-v1',value);assert.equal(result.valid,true,result.errors);return value; }
function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-controller-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'file.ts'),'before');
 const facts={identity:{projectRef:'project',sessionRef:'session',runtimeInstanceId:'runtime',taskId:null,taskRunId:null,agentOperationId:null,toolCallId:null},writable:true,agentRunning:false};
 const journal=[];let writes=0;
 const options={facts:()=>facts,history:()=>journal,append:receipt=>journal.push(structuredClone(valid(receipt))),
  write:payload=>{writes++;return {state:'saved',...writeWorkspaceFile(root,payload,{policy:{},profile:{}})};}};
 const controller=new WorkspaceWriteController(options);
 return {root,facts,journal,options,controller,writes:()=>writes};
}
async function command(controller,overrides={}) {
 const state=valid(await controller.state()), now=Date.now();
 const c={schemaVersion:1,version:'piagent-webui-workspace-write-v1',messageType:'command',commandId:randomUUID(),idempotencyKey:randomUUID(),
  requestedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),action:'workspace.write',identity:state.identity,
  expectedRevisions:state.revisions,payload:{path:'file.ts',content:'member edit',expectedDigest:sha('before')},...overrides};
 c.actionDigest=workspaceWriteDigest(c);return valid(c);
}
test('workspace save serializes duplicate requests and replays its durable receipt after controller recreation',async t=>{
 const f=setup(t),c=await command(f.controller),before=await f.controller.state();
 const [a,b]=await Promise.all([f.controller.execute(c),f.controller.execute(c)]);
 assert.equal(a.phase,'settled');assert.equal(b.deduplicated,true);assert.equal(f.writes(),1);
 assert.notEqual((await f.controller.state()).revisions.workspaceRevision,before.revisions.workspaceRevision);
 const replay=await new WorkspaceWriteController(f.options).execute(c);
 assert.deepEqual(replay,{...a,deduplicated:true});assert.equal(f.writes(),1);
 const originalIdentity=f.facts.identity; f.facts.identity={...originalIdentity,runtimeInstanceId:'restarted-gateway'};
 assert.deepEqual(await new WorkspaceWriteController(f.options).execute(c),{...a,deduplicated:true});assert.equal(f.writes(),1);
 f.facts.identity=originalIdentity;
 const altered={...c,payload:{...c.payload,content:'different'}};altered.actionDigest=workspaceWriteDigest(altered);
 assert.equal((await f.controller.execute(altered)).resultCode,'idempotency-payload-mismatch');assert.equal(f.writes(),1);
});
test('workspace save returns current digest on an agent edit and does not overwrite it',async t=>{
 const f=setup(t),c=await command(f.controller);fs.writeFileSync(path.join(f.root,'file.ts'),'agent edit');
 const receipt=valid(await f.controller.execute(c));
 assert.equal(receipt.resultCode,'stale-content');assert.equal(receipt.currentDigest,sha('agent edit'));
 assert.equal(fs.readFileSync(path.join(f.root,'file.ts'),'utf8'),'agent edit');
 assert.equal((await f.controller.execute(c)).deduplicated,true);assert.equal(f.writes(),1);
});
test('workspace save refuses identity, revision, expiry and permission drift before mutation',async t=>{
 const f=setup(t);
 for(const kind of ['identity','revision','expiry','permission']) {
  const c=await command(f.controller);
  if(kind==='identity') c.identity={...c.identity,sessionRef:'another'};
  if(kind==='revision') c.expectedRevisions={workspaceRevision:'stale'};
  if(kind==='expiry') {c.requestedAt=new Date(Date.now()-120000).toISOString();c.expiresAt=new Date(Date.now()-60000).toISOString();}
  if(kind==='permission') f.facts.writable=false;
  c.actionDigest=workspaceWriteDigest(c);
  const result=await f.controller.execute(c);valid(result);
  assert.equal(result.resultCode,{identity:'identity-mismatch',revision:'stale-revision',expiry:'expired',permission:'read-only'}[kind]);
 }
 assert.equal(f.writes(),0);
});
test('uncertain dispatch and a lost settlement cannot authorize a second write',async t=>{
 const f=setup(t),write=f.options.write;
 f.options.write=payload=>{write(payload);throw new Error('response-lost');};
 const c=await command(f.controller),receipt=await f.controller.execute(c);
 assert.equal(receipt.phase,'uncertain');assert.equal(fs.readFileSync(path.join(f.root,'file.ts'),'utf8'),'member edit');
 assert.equal((await new WorkspaceWriteController(f.options).execute(c)).phase,'uncertain');assert.equal(f.writes(),1);
});
test('workspace save refuses tampered digest or unknown payload fields',async t=>{
 const f=setup(t),c=await command(f.controller);
 assert.throws(()=>f.controller.execute({...c,payload:{...c.payload,content:'tampered'}}),/invalid-workspace-write-command/);
 const extra={...c,payload:{...c.payload,force:true}};extra.actionDigest=workspaceWriteDigest(extra);
 assert.throws(()=>f.controller.execute(extra),/invalid-workspace-write-command/);assert.equal(f.writes(),0);
});
