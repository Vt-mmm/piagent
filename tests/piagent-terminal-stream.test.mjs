import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalWebSocketStream } from '../packages/piagent-webui/server/terminal-websocket-stream.ts';
const output=(sequence=1)=>({schemaVersion:1,version:'piagent-terminal-v1',messageType:'output',identity:{gatewayInstanceRef:'gateway.one',runtimeInstanceRef:'runtime.one',sessionRef:'session.one'},terminalRef:'terminal.one',sequence,data:'output',replay:false,reset:false,complete:true,truncated:false});
function fixture(){
 let listener,detached=0,authorized=true;const sent=[],closed=[];
 const stream=new TerminalWebSocketStream({port:{subscribe(_ref,fn){listener=fn;return()=>{detached++;};},replay:()=>[{...output(),replay:true,reset:true}]},
 authorized:()=>authorized,send:message=>sent.push(message),close:reason=>closed.push(reason)});
 return {stream,sent,closed,emit:message=>listener(message),detached:()=>detached,revoke:()=>{authorized=false;}};
}
test('pending terminal output is bounded and overflow abandons the subscription',()=>{
 const f=fixture(),replay=f.stream.begin('session.one','csrf');
 for(let i=0;i<257;i++)f.emit(output(i));
 assert.deepEqual(f.closed,['terminal-backpressure']);assert.equal(f.detached(),1);
 replay.finish(()=>assert.fail('overflow must not send a ready response'));assert.deepEqual(f.sent,[]);
});
test('terminal stream authenticates buffered and live messages and stopped replay cannot restart',()=>{
 const f=fixture(),replay=f.stream.begin('session.one','csrf');f.emit(output());f.revoke();
 replay.finish(()=>{});assert.deepEqual(f.sent,[]);assert.deepEqual(f.closed,['terminal-session-expired']);
 const next=fixture(),pending=next.stream.begin('session.one','csrf');next.stream.stop();
 pending.finish(()=>assert.fail('closed stream must not send response'));next.emit(output());assert.deepEqual(next.sent,[]);
});
