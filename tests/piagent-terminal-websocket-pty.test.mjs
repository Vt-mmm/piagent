import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {PersonalTerminalSessions} from '../packages/piagent-webui/gateway/personal-terminal-sessions.ts';
import {sessionRefForPath} from '../packages/piagent-webui/gateway/session-catalog.ts';
import {GatewayProtocolService} from '../packages/piagent-webui/gateway/gateway-protocol-service.ts';
import {SessionAuthority} from '../packages/piagent-webui/server/session-auth.ts';
import {attachGatewayWebSocket} from '../packages/piagent-webui/server/gateway-websocket.ts';
import {controlActionDigest} from '../packages/piagent-webui/server/control-command-digest.ts';

test('authenticated Gateway PTY survives socket reload and replays before subsequent live output', {timeout:15000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-socket-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const key=Buffer.alloc(32,8),info={id:'raw',path:path.join(root,'session.jsonl'),cwd:root},ref=sessionRefForPath(key,info.path);
 const manager={getSessionId:()=>info.id,buildSessionContext:()=>({model:{provider:'personal'}})};
 const owner={gatewayInstanceRef:'gateway.one',runtimeInstanceRef:'runtime.one',ownerEpoch:1,continuity:'exact'};
 const terminals=new PersonalTerminalSessions({key,gatewayInstanceRef:'gateway.one',managed:false,runtimes:{listSessions:async()=>[info],
 acquire:async()=>({...owner}),liveSessionManager:()=>manager,ownership:()=>({state:'gateway-owned',owner})}});
 const server=createServer(),authority=new SessionAuthority();
 const protocol=new GatewayProtocolService({capabilities:()=>({}),catalog:async()=>({}),terminals,terminalEvents:terminals});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;authority.bindPort(server.address().port);
 const transport=attachGatewayWebSocket({server,origin:()=>origin,authority,protocol});
 t.after(async()=>{await transport.close();await terminals.dispose();await new Promise(r=>server.close(r));});
 const session=authority.exchange(authority.bootstrapCapability),cookie=authority.cookieHeader(session).split(';',1)[0];let id=0;
 async function connect(){
  const socket=new WebSocket(origin.replace('http:','ws:')+'/api/v1/gateway','piagent.gateway.v1',{origin,headers:{Cookie:cookie}});
  const received=[],waiters=[];
  socket.on('message',data=>{received.push(JSON.parse(data.toString()));for(const resolve of waiters.splice(0))resolve();});
  const take=async predicate=>{for(;;){const index=received.findIndex(predicate);if(index>=0)return received.splice(index,1)[0];await new Promise(r=>waiters.push(r));}};
  await once(socket,'open');socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'connect',clientRef:'client.pty',minimumProtocol:1,maximumProtocol:1,lastEventSequence:null,catalogRevision:null}));
  await take(m=>m.messageType==='hello');
  const request=async(method,params)=>{const requestId=`terminal_request_${++id}`;socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'request',requestId,method,params:{...params,csrfToken:session.csrf}}));const response=await take(m=>m.requestId===requestId);assert.equal(response.ok,true);return response.result;};
  const state=()=>request('terminals.state',{sessionRef:ref});
  const execute=async payload=>{const current=await state(),command={schemaVersion:1,version:'piagent-terminal-v1',messageType:'command',commandId:`command.${++id}`,idempotencyKey:`key.${id}`,
   requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),action:'terminal.command',identity:current.identity,expectedRevisions:current.revisions,payload};
   return request('terminals.command',{command:{...command,actionDigest:controlActionDigest(command)}});};
  return {socket,take,state,execute};
 }
 const first=await connect(),opened=await first.execute({kind:'open',cols:80,rows:24});assert.equal(opened.phase,'settled');
 await first.execute({kind:'input',terminalRef:opened.terminalRef,data:"printf 'SOCKET_READY\\n'\n"});
 await first.take(m=>m.messageType==='output'&&!m.replay&&m.data.includes('SOCKET_READY\r\n'));
 const disconnected=once(first.socket,'close');first.socket.close();await disconnected;
 const second=await connect(),current=await second.state();assert.equal(current.terminals[0].terminalRef,opened.terminalRef);
 const replay=await second.take(m=>m.messageType==='output'&&m.replay&&m.data.includes('SOCKET_READY\r\n'));assert.equal(replay.reset,true);
 await second.execute({kind:'resize',terminalRef:opened.terminalRef,cols:99,rows:33});
 await second.execute({kind:'input',terminalRef:opened.terminalRef,data:'stty size\n'});
 await second.take(m=>m.messageType==='output'&&!m.replay&&m.data.includes('33 99'));
 assert.equal((await second.execute({kind:'close',terminalRef:opened.terminalRef})).phase,'settled');
 assert.equal((await second.state()).terminals.length,0);
});
