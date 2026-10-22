import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { SessionAuthority } from '../packages/piagent-webui/server/session-auth.ts';
import { attachGatewayWebSocket } from '../packages/piagent-webui/server/gateway-websocket.ts';
import { GatewayProtocolService } from '../packages/piagent-webui/gateway/gateway-protocol-service.ts';
import { parseTerminalCommand } from '../packages/piagent-webui/server/terminal-command.ts';
import { controlActionDigest } from '../packages/piagent-webui/server/control-command-digest.ts';
import { createWebUiSchemaRegistry, validateFixture } from './helpers/piagent-webui-schema-registry.mjs';
const state=JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/terminal-v1.valid.json',import.meta.url)));
const registry=createWebUiSchemaRegistry();
function command(payload={kind:'open',cols:80,rows:24}) {
 const value={schemaVersion:1,version:'piagent-terminal-v1',messageType:'command',commandId:'command.fixture',idempotencyKey:'key.fixture',
 requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),action:'terminal.command',identity:structuredClone(state.identity),expectedRevisions:structuredClone(state.revisions),payload};
 return {...value,actionDigest:controlActionDigest(value)};
}
function inbox(socket) {
 const queue=[],waiters=[];
 socket.on('message',data=>{const value=JSON.parse(data.toString());const waiter=waiters.shift();if(waiter)waiter(value);else queue.push(value);});
 return ()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiters.push(resolve));
}
test('existing Gateway socket checks terminal CSRF and current cookie before command dispatch', {timeout:10000}, async t=>{
 const server=createServer(),authority=new SessionAuthority();let effects=0,reads=0;
 const protocol=new GatewayProtocolService({capabilities:()=>({}),catalog:async()=>({state:'ready',sessions:[]}),terminals:{
 state:async ref=>{assert.equal(ref,state.identity.sessionRef);reads++;return state;},
 execute:async value=>{effects++;return {schemaVersion:1,version:'piagent-terminal-v1',messageType:'receipt',commandId:value.commandId,idempotencyKey:value.idempotencyKey,
 action:value.action,actionDigest:value.actionDigest,identity:value.identity,observedRevisions:state.revisions,phase:'settled',terminalRef:'terminal.fixture',reasonCode:null,deduplicated:false};}
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;authority.bindPort(server.address().port);
 const transport=attachGatewayWebSocket({server,origin:()=>origin,authority,protocol});
 t.after(async()=>{await transport.close();await new Promise(resolve=>server.close(resolve));});
 const session=authority.exchange(authority.bootstrapCapability),cookie=authority.cookieHeader(session).split(';',1)[0];
 const other=authority.exchange(authority.issueBootstrapCapability());
 async function connect(){const socket=new WebSocket(origin.replace('http:','ws:')+'/api/v1/gateway','piagent.gateway.v1',{origin,headers:{Cookie:cookie}}),next=inbox(socket);
 await once(socket,'open');socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'connect',clientRef:'client.fixture',minimumProtocol:1,maximumProtocol:1,lastEventSequence:null,catalogRevision:null}));
 assert.equal((await next()).messageType,'hello');return {socket,next};}
 const {socket,next}=await connect();
 const send=(method,params)=>{socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'request',requestId:'terminal_request_01',method,params}));return next();};
 assert.equal((await send('terminals.state',{sessionRef:state.identity.sessionRef,csrfToken:other.csrf})).ok,false);assert.equal(reads,0);
 const read=await send('terminals.state',{sessionRef:state.identity.sessionRef,csrfToken:session.csrf});assert.equal(read.ok,true);
 assert.equal(validateFixture(registry,'gateway-protocol-v1',read).valid,true);
 const value=command();const accepted=await send('terminals.command',{command:value,csrfToken:session.csrf});
 assert.equal(accepted.ok,true);assert.equal(effects,1);assert.equal(validateFixture(registry,'gateway-protocol-v1',accepted).valid,true);
 const forged=structuredClone(value);forged.payload.cols=120;
 assert.equal((await send('terminals.command',{command:forged,csrfToken:session.csrf})).ok,false);assert.equal(effects,1);
 assert.equal((await send('terminals.command',{command:command({kind:'input',terminalRef:'terminal.fixture',data:'é'.repeat(9000)}),csrfToken:session.csrf})).ok,false);
 assert.equal(effects,1);
 const missing=await connect();const closed=once(missing.socket,'close');missing.socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'request',requestId:'terminal_request_02',method:'terminals.command',params:{command:value}}));
 assert.equal((await closed)[0],1008);assert.equal(effects,1);
 session.expiresAt=0;assert.equal((await send('terminals.command',{command:value,csrfToken:session.csrf})).ok,false);assert.equal(effects,1);
});

test('terminal command contract rejects extra authority, invalid dimensions and oversized lifetime',()=>{
 for(const payload of [{kind:'open',cols:80,rows:24},{kind:'input',terminalRef:'terminal.fixture',data:'echo hello\n'},
 {kind:'resize',terminalRef:'terminal.fixture',cols:120,rows:40},{kind:'close',terminalRef:'terminal.fixture'}]){
 const value=command(payload);assert.deepEqual(parseTerminalCommand(value),value);assert.equal(validateFixture(registry,'terminal-v1',value).valid,true);
 }
 for(const mutate of [value=>value.identity.cwd='/tmp',value=>value.payload.cols=0,value=>value.payload.shell='/bin/sh',
 value=>value.expiresAt=new Date(Date.now()+600000).toISOString()]){
 const value=command();mutate(value);value.actionDigest=controlActionDigest(value);assert.throws(()=>parseTerminalCommand(value),/terminal-command-invalid/);
 }
});

test('terminal socket subscribes before replay, scopes streams and stops output after cookie revocation', {timeout:10000},async t=>{
 const server=createServer(),authority=new SessionAuthority(),listeners=new Map();let detached=0,reads=0;
 const output=(sessionRef,sequence,data,replay=false)=>({schemaVersion:1,version:'piagent-terminal-v1',messageType:'output',
 identity:{...state.identity,sessionRef},terminalRef:'terminal.fixture',sequence,data,replay,reset:replay,complete:true,truncated:false});
 const emit=(ref,message)=>{for(const listener of listeners.get(ref)??[])listener(message);};
 const port={subscribe(ref,listener){const entries=listeners.get(ref)??new Set();entries.add(listener);listeners.set(ref,entries);
 return ()=>{entries.delete(listener);detached++;};},replay:ref=>[output(ref,1,'redacted retained output',true)]};
 const protocol=new GatewayProtocolService({capabilities:()=>({}),catalog:async()=>({state:'ready',sessions:[]}),terminalEvents:port,
 terminals:{state:async ref=>{reads++;assert.equal(listeners.get(ref)?.size,1);emit(ref,output(ref,1,'already in snapshot'));
 await Promise.resolve();return {...state,identity:{...state.identity,sessionRef:ref}};},execute:async()=>null}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;authority.bindPort(server.address().port);
 const transport=attachGatewayWebSocket({server,origin:()=>origin,authority,protocol});t.after(async()=>{await transport.close();await new Promise(r=>server.close(r));});
 const session=authority.exchange(authority.bootstrapCapability),cookie=authority.cookieHeader(session).split(';',1)[0];
 const socket=new WebSocket(origin.replace('http:','ws:')+'/api/v1/gateway','piagent.gateway.v1',{origin,headers:{Cookie:cookie}}),next=inbox(socket);
 await once(socket,'open');socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'connect',clientRef:'client.stream',minimumProtocol:1,maximumProtocol:1,lastEventSequence:null,catalogRevision:null}));
 await next();
 const request=ref=>socket.send(JSON.stringify({schemaVersion:1,version:'piagent-gateway-protocol-v1',messageType:'request',requestId:'terminal_stream_01',method:'terminals.state',params:{sessionRef:ref,csrfToken:session.csrf}}));
 request('session.one');assert.equal((await next()).messageType,'response');const replay=await next();assert.equal(replay.replay,true);
 assert.equal(validateFixture(registry,'terminal-v1',replay).valid,true,JSON.stringify(validateFixture(registry,'terminal-v1',replay)));
 emit('session.one',output('session.one',2,'live next'));assert.equal((await next()).data,'live next');
 request('session.two');assert.equal((await next()).messageType,'response');assert.equal((await next()).identity.sessionRef,'session.two');
 assert.equal(listeners.get('session.one').size,0);assert.equal(detached,1);
 emit('session.one',output('session.one',3,'wrong session'));emit('session.two',output('session.two',2,'selected session'));
 assert.equal((await next()).data,'selected session');assert.equal(reads,2);
 const closed=once(socket,'close');authority.invalidate();emit('session.two',output('session.two',3,'must not arrive'));
 assert.equal((await closed)[0],1008);assert.equal(listeners.get('session.two').size,0);
});
