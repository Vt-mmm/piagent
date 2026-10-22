import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TerminalTransport,terminalMessage} from '../packages/piagent-webui/client/src/terminal-transport.ts';
import {terminalCommand} from '../packages/piagent-webui/client/src/terminal-command.ts';
import {parseTerminalCommand} from '../packages/piagent-webui/server/terminal-command.ts';
const state=JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/terminal-v1.valid.json',import.meta.url)));
test('terminal wire accepts unknown exit status and rejects unexpected private fields',()=>{
 const exit={schemaVersion:1,version:'piagent-terminal-v1',messageType:'exit',identity:state.identity,
  terminalRef:'terminal.one',sequence:1,exitCode:null,signal:null};
 assert.equal(terminalMessage(exit),true);
 assert.equal(terminalMessage({...exit,privateGrant:'must-not-forward'}),false);
 assert.equal(terminalMessage({...state,identity:{...state.identity,privateGrant:'must-not-forward'}}),false);
});
class Socket extends EventTarget {
 readyState=1;sent=[];
 send(data){this.sent.push(JSON.parse(data));}
 frame(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
 hello(){this.frame({version:'piagent-gateway-protocol-v1',messageType:'hello'});}
 reply(result,extra={}){const request=this.sent.at(-1);this.frame({version:'piagent-gateway-protocol-v1',messageType:'response',requestId:request.requestId,method:request.method,ok:true,result,...extra});}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
const receipt=command=>({schemaVersion:1,version:command.version,messageType:'receipt',commandId:command.commandId,idempotencyKey:command.idempotencyKey,
 action:command.action,actionDigest:command.actionDigest,identity:command.identity,observedRevisions:state.revisions,phase:'settled',terminalRef:'terminal.one',reasonCode:null,deduplicated:false});
test('browser terminal commands match server digest and transport sends CSRF with exact unchanged retry',async()=>{
 const transport=new TerminalTransport(()=> 'csrf.fixture'),socket=new Socket();transport.attach(socket);socket.hello();
 const read=transport.state(state.identity.sessionRef);assert.equal(socket.sent[0].params.csrfToken,'csrf.fixture');socket.reply(state);assert.deepEqual(await read,state);
 const command=await terminalCommand(state,{kind:'input',terminalRef:'terminal.one',data:'echo hello\n'});
 assert.deepEqual(parseTerminalCommand(command),command);
 const pending=transport.execute(command);socket.reply(receipt(command));assert.equal((await pending).phase,'settled');
 const retry=transport.execute(command);assert.deepEqual(socket.sent.at(-1).params.command,command);socket.reply({...receipt(command),deduplicated:true});assert.equal((await retry).deduplicated,true);
 socket.close();
});
test('browser terminal transport rejects mismatched receipts and pending sends when socket disappears',async()=>{
 const transport=new TerminalTransport(()=> 'csrf.fixture'),socket=new Socket();transport.attach(socket);socket.hello();
 const command=await terminalCommand(state,{kind:'open',cols:80,rows:24});
 const forged=transport.execute(command);socket.reply({...receipt(command),identity:{...command.identity,runtimeInstanceRef:'runtime.other'}});
 await assert.rejects(forged,/terminal-receipt-invalid/);
 const pending=transport.execute(command);socket.close();await assert.rejects(pending,/terminal-connection-lost/);
 await assert.rejects(transport.execute(command),/terminal-not-connected/);
 const replacement=new Socket();transport.attach(replacement);replacement.hello();socket.close();assert.equal(transport.ready,true);replacement.close();
});
test('terminal frames route separately from Gateway events and malformed output is ignored',()=>{
 const transport=new TerminalTransport(()=> 'csrf.fixture'),socket=new Socket(),seen=[];transport.attach(socket);socket.hello();const unsubscribe=transport.subscribe(message=>seen.push(message));
 const output={schemaVersion:1,version:'piagent-terminal-v1',messageType:'output',identity:state.identity,terminalRef:'terminal.one',sequence:1,data:'hello',replay:false,reset:false,complete:true,truncated:false};
 assert.equal(terminalMessage(output),true);socket.frame(output);socket.frame({...output,data:'a'.repeat(8193)});socket.frame({...output,sequence:-1});
 socket.frame({version:'piagent-gateway-protocol-v1',messageType:'event',sequence:1});assert.deepEqual(seen,[output]);
 unsubscribe();socket.frame(output);assert.equal(seen.length,1);socket.close();
});
