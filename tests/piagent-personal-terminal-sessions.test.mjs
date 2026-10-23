import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalTerminalSessions } from '../packages/piagent-webui/gateway/personal-terminal-sessions.ts';
import { PersonalTerminalProcesses } from '../packages/piagent-webui/gateway/personal-terminal-processes.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { controlActionDigest } from '../packages/piagent-webui/server/control-command-digest.ts';
const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('terminal-timeout');await new Promise(r=>setTimeout(r,20));}};
function setup(t, unavailable=false, factory){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-service-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const key=Buffer.alloc(32,9),info={id:'raw',path:path.join(cwd,'session.jsonl'),cwd},ref=sessionRefForPath(key,info.path);
  const manager={getSessionId:()=>info.id,buildSessionContext:()=>({model:{provider:'personal'}})};
  const owner={gatewayInstanceRef:'gateway.one',runtimeInstanceRef:'runtime.one',ownerEpoch:1,continuity:'exact'};
  const runtimes={listSessions:async()=>[info],acquire:async()=>({...owner}),liveSessionManager:()=>manager,
    ownership:()=>({state:'gateway-owned',owner})};
  const service=new PersonalTerminalSessions({key,managed:false,gatewayInstanceRef:'gateway.one',runtimes},factory??(emit=>
    unavailable ? new PersonalTerminalProcesses(emit,()=>{throw Error('absent');}) : new PersonalTerminalProcesses(emit)));
  t.after(()=>service.dispose());let id=0;
  const command=async payload=>{const state=await service.state(ref),value={schemaVersion:1,version:'piagent-terminal-v1',messageType:'command',
    commandId:`command.${++id}`,idempotencyKey:`key.${id}`,requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),
    action:'terminal.command',identity:state.identity,expectedRevisions:state.revisions,payload};return {...value,actionDigest:controlActionDigest(value)};};
  return {service,ref,owner,command,cwd};
}
test('personal terminal service opens once, streams, replays redacted output and closes real PTY',async t=>{
  const f=setup(t),messages=[];const unsubscribe=f.service.subscribe(f.ref,message=>messages.push(message));t.after(unsubscribe);
  const open=await f.command({kind:'open',cols:80,rows:24});
  const [first,retry]=await Promise.all([f.service.execute(open),f.service.execute(open)]);
  assert.equal(first.phase,'settled');assert.equal(retry.deduplicated,true);assert.equal(first.terminalRef,retry.terminalRef);
  assert.equal((await f.service.state(f.ref)).terminals.length,1);
  const input=await f.command({kind:'input',terminalRef:first.terminalRef,data:"printf 'SERVICE_READY\\n'; echo $$ > shell.pid\n"});
  assert.equal((await f.service.execute(input)).phase,'settled');
  await until(()=>messages.some(m=>m.messageType==='output'&&m.data.includes('SERVICE_READY\r\n'))&&fs.existsSync(path.join(f.cwd,'shell.pid')));
  const shell=Number(fs.readFileSync(path.join(f.cwd,'shell.pid'),'utf8'));
  unsubscribe();
  const secret='sk-'+ 'a'.repeat(48);
  await f.service.execute(await f.command({kind:'input',terminalRef:first.terminalRef,data:`printf 'OPENAI_API_KEY=${secret}\\n'\n`}));
  await until(()=>f.service.forAgent(f.ref).text.includes('REDACTED'));
  const replay=f.service.replay(f.ref);assert.equal(replay[0].reset,true);assert.equal(replay.at(-1).complete,true);
  assert.ok(replay.every(m=>m.replay&&m.data.length<=8192));assert.ok(!replay.map(m=>m.data).join('').includes(secret));
  assert.ok(!f.service.forAgent(f.ref).text.includes(secret));
  await f.service.closeSession(f.ref);
  await until(()=>{try{process.kill(shell,0);return false;}catch{return true;}});
  assert.equal(f.service.replay(f.ref).length,0);
});
test('service refuses stale/replaced authority, limits tabs and never replays open into replacement runtime',async t=>{
  const f=setup(t),open=await f.command({kind:'open',cols:80,rows:24});
  await f.service.execute(open);
  const stale={...open,commandId:'command.stale',idempotencyKey:'key.stale'};stale.actionDigest=controlActionDigest(stale);
  assert.equal((await f.service.execute(stale)).reasonCode,'terminal-stale-revision');
  for(let i=0;i<3;i++)assert.equal((await f.service.execute(await f.command({kind:'open',cols:80,rows:24}))).phase,'settled');
  assert.equal((await f.service.execute(await f.command({kind:'open',cols:80,rows:24}))).reasonCode,'terminal-limit');
  const old=await f.command({kind:'open',cols:80,rows:24});f.owner.runtimeInstanceRef='runtime.two';
  assert.equal((await f.service.execute(old)).reasonCode,'terminal-runtime-replaced');
  assert.equal((await f.service.state(f.ref)).terminals.length,0);
  assert.equal((await f.service.execute(open)).deduplicated,true);
  assert.equal((await f.service.state(f.ref)).terminals.length,0);
});
test('missing native PTY leaves state available with an explicit unavailable reason',async t=>{
  const f=setup(t,true),state=await f.service.state(f.ref);
  assert.equal(state.available,false);assert.equal(state.reasonCode,'terminal-native-module-unavailable');
  assert.equal((await f.service.execute(await f.command({kind:'open',cols:80,rows:24}))).phase,'rejected');
});

test('actual runtime release and restart close their PTYs before replacing ownership',async t=>{
  const {SessionRuntimeSupervisor}=await import('../packages/piagent-webui/gateway/session-runtime-supervisor.ts');
  const {SessionLeaseStore}=await import('../packages/piagent-webui/gateway/session-lease-store.ts');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.chmodSync(root,0o700);const key=Buffer.alloc(32,5),gatewayInstanceRef='gateway.terminaltest';
  const info={id:'raw-terminal',path:path.join(root,'session.jsonl'),cwd:root,created:new Date(),modified:new Date(),messageCount:0,firstMessage:'',allMessagesText:''};
  const ref=sessionRefForPath(key,info.path),manager={getSessionId:()=>info.id,buildSessionContext:()=>({model:{provider:'personal'}})};
  let service;
  const runtimes=new SessionRuntimeSupervisor({key,gatewayInstanceRef,leases:new SessionLeaseStore(root,key),listSessions:async()=>[info],
    closeSessionResources:async sessionRef=>service.closeSession(sessionRef),
    runtimeFactory:async()=>({session:{sessionManager:manager,isIdle:true},dispose:async()=>{}})});
  service=new PersonalTerminalSessions({key,gatewayInstanceRef,managed:false,runtimes});
  t.after(async()=>{await service.dispose();await runtimes.close();});let id=0;
  const execute=async payload=>{const state=await service.state(ref),command={schemaVersion:1,version:'piagent-terminal-v1',messageType:'command',
    commandId:`command.${++id}`,idempotencyKey:`key.${id}`,requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),
    action:'terminal.command',identity:state.identity,expectedRevisions:state.revisions,payload};
    return service.execute({...command,actionDigest:controlActionDigest(command)});};
  for(const operation of ['restart','release']){
    const opened=await execute({kind:'open',cols:80,rows:24});assert.equal(opened.phase,'settled');
    await execute({kind:'input',terminalRef:opened.terminalRef,data:`echo $$ > ${operation}.pid\n`});
    const file=path.join(root,`${operation}.pid`);await until(()=>fs.existsSync(file));const pid=Number(fs.readFileSync(file,'utf8'));
    await runtimes[operation](ref);
    await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}});
    assert.equal(service.replay(ref).length,0);
  }
});

test('a flood of output is paced, pauses the terminal, drops the oldest unsent part and flushes before exit',async t=>{
  let emit;const calls=[];
  const f=setup(t,false,e=>{emit=e;return {unavailableReason:null,open:()=>({terminalRef:'terminal.flood',pid:1}),input(){},resize(){},
    close:async()=>{},closeSession:async()=>{},dispose:async()=>{},pause:()=>calls.push('pause'),resume:()=>calls.push('resume')};});
  const messages=[];t.after(f.service.subscribe(f.ref,message=>messages.push(message)));
  const opened=await f.service.execute(await f.command({kind:'open',cols:80,rows:24}));
  const chunk='y\n'.repeat(16*1024);
  for(let i=0;i<64;i++)emit({sessionRef:f.ref,terminalRef:opened.terminalRef,kind:'output',data:chunk});
  const live=()=>messages.filter(m=>m.messageType==='output');
  assert.equal(live().length,0,'nothing is sent in the same tick as 2 MB arrives');
  assert.deepEqual(calls,['pause']);
  await until(()=>calls.includes('resume'));
  const sent=live().map(m=>m.data).join('');
  assert.ok(sent.includes('output skipped'));assert.ok(sent.length<=1024*1024+128,'at most the retained window is sent');
  emit({sessionRef:f.ref,terminalRef:opened.terminalRef,kind:'output',data:'LAST LINE\n'});
  emit({sessionRef:f.ref,terminalRef:opened.terminalRef,kind:'exit',exitCode:0,signal:null});
  const exit=messages.findIndex(m=>m.messageType==='exit');
  assert.ok(exit>0&&messages.slice(0,exit).some(m=>m.messageType==='output'&&m.data.includes('LAST LINE')));
});
test('a real flood (yes) keeps the terminal usable and reaches the command after it',async t=>{
  const f=setup(t),messages=[];t.after(f.service.subscribe(f.ref,message=>messages.push(message)));
  const opened=await f.service.execute(await f.command({kind:'open',cols:80,rows:24}));
  await f.service.execute(await f.command({kind:'input',terminalRef:opened.terminalRef,data:"yes | head -c 1000000; echo FLOOD_$((40+2))\n"}));
  await until(()=>messages.some(m=>m.messageType==='output'&&m.data.includes('FLOOD_42\r\n')),30000);
  assert.ok(messages.filter(m=>m.messageType==='output').every(m=>m.data.length<=8192));
  await f.service.execute(await f.command({kind:'input',terminalRef:opened.terminalRef,data:"echo AFTER_$((40+2))\n"}));
  await until(()=>messages.some(m=>m.messageType==='output'&&m.data.includes('AFTER_42\r\n')),30000);
});
