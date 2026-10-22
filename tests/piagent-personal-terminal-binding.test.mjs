import test from 'node:test';
import assert from 'node:assert/strict';
import { personalTerminalBinding } from '../packages/piagent-webui/gateway/personal-terminal-binding.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';

function fixture() {
  const key = Buffer.alloc(32, 7), info = {path:'/sessions/member.jsonl',id:'raw-session',cwd:'/project'};
  const sessionRef = sessionRefForPath(key, info.path);
  let provider = 'personal', acquisitions = 0;
  const manager = {getSessionId:()=>info.id,buildSessionContext:()=>({model:{provider}})};
  const owner = {continuity:'exact',gatewayInstanceRef:'gateway.one',runtimeInstanceRef:'runtime.one',ownerEpoch:1};
  const runtimes = {listSessions:async()=>[info],acquire:async()=>{acquisitions++;return {...owner};},
    liveSessionManager:()=>manager,ownership:()=>({state:'gateway-owned',owner})};
  return {options:{key,managed:false,gatewayInstanceRef:'gateway.one',runtimes},sessionRef,manager,owner,
    setProvider:value=>{provider=value;},acquisitions:()=>acquisitions};
}

test('personal terminal binds only unique trusted catalog cwd and exact current runtime', async()=>{
  const f=fixture(), binding=await personalTerminalBinding(f.options,f.sessionRef);
  assert.deepEqual(binding.scope,{sessionRef:f.sessionRef,mode:'personal',cwd:'/project'});
  binding.assertCurrent();
  f.owner.runtimeInstanceRef='runtime.replacement';
  assert.throws(()=>binding.assertCurrent(),/terminal-runtime-replaced/);
  f.owner.runtimeInstanceRef='runtime.one';f.owner.ownerEpoch=2;
  assert.throws(()=>binding.assertCurrent(),/terminal-runtime-replaced/);
});

test('terminal binding rejects company and unknown or ambiguous catalog refs before acquire',async()=>{
  const f=fixture();
  await assert.rejects(personalTerminalBinding({...f.options,managed:true},f.sessionRef),/company-boundary-required/);
  await assert.rejects(personalTerminalBinding(f.options,'session.unknown'),/terminal-session-unavailable/);
  const entries=await f.options.runtimes.listSessions();f.options.runtimes.listSessions=async()=>[...entries,...entries];
  await assert.rejects(personalTerminalBinding(f.options,f.sessionRef),/terminal-session-unavailable/);
  assert.equal(f.acquisitions(),0);
});

test('terminal authority is revoked when manager, provider or lease continuity changes',async()=>{
  for(const change of [f=>{f.options.runtimes.liveSessionManager=()=>({...f.manager});},
    f=>f.setProvider('agent_watch_managed'),f=>{f.owner.continuity='uncertain';},
    f=>{f.owner.gatewayInstanceRef='gateway.other';},f=>{f.manager.getSessionId=()=>'other';}]){
    const f=fixture(),binding=await personalTerminalBinding(f.options,f.sessionRef);change(f);
    assert.throws(()=>binding.assertCurrent(),/terminal-runtime-replaced|company-boundary-required/);
  }
  const f=fixture();f.setProvider('agent_watch_managed');
  await assert.rejects(personalTerminalBinding(f.options,f.sessionRef),/company-boundary-required/);
});
