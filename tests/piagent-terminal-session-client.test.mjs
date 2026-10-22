import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TerminalSessionClient } from '../packages/piagent-webui/client/src/terminal-session-client.ts';
const initial=JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/terminal-v1.valid.json',import.meta.url)));
function fixture(){
 let state=structuredClone(initial),fail=false,release;const sent=[];
 const transport={ready:true,subscribe:()=>()=>{},connection:()=>()=>{},state:async()=>state,
 execute:async command=>{sent.push(command);if(fail){await new Promise(resolve=>release=resolve);throw Error('terminal-response-timeout');}
 state={...state,revisions:{terminalRevision:`revision.${sent.length}`}};
 return {phase:'settled',identity:command.identity,observedRevisions:state.revisions};}};
 const client=new TerminalSessionClient(initial.identity.sessionRef,transport);
 return {client,sent,setFail:value=>{fail=value;},release:()=>release?.()};
}
test('terminal controller serializes input against receipt revisions',async()=>{
 const f=fixture();await f.client.refresh();
 await Promise.all(['a','b','\n'].map(data=>f.client.execute({kind:'input',terminalRef:'terminal.one',data})));
 assert.deepEqual(f.sent.map(c=>c.payload.data),['a','b','\n']);
 assert.deepEqual(f.sent.map(c=>c.expectedRevisions.terminalRevision),[initial.revisions.terminalRevision,'revision.1','revision.2']);
 assert.equal(f.client.snapshot().pending,null);
});
test('lost receipt retains exact command and drops queued input until explicitly resolved',async()=>{
 const f=fixture();await f.client.refresh();f.setFail(true);
 const first=f.client.execute({kind:'input',terminalRef:'terminal.one',data:'echo first\n'});
 const queued=f.client.execute({kind:'input',terminalRef:'terminal.one',data:'must not run\n'});
 while(!f.sent.length)await new Promise(r=>setImmediate(r));f.release();await Promise.all([first,queued]);
 assert.equal(f.sent.length,1);const pending=f.client.snapshot().pending;assert.deepEqual(pending,f.sent[0]);
 await f.client.execute({kind:'open',cols:80,rows:24});assert.equal(f.sent.length,1);
 f.setFail(false);await f.client.retry();assert.deepEqual(f.sent[1],pending);assert.equal(f.client.snapshot().pending,null);
});
test('terminal controller bounds pasted input before dispatch',async()=>{
 const f=fixture();await f.client.refresh();await f.client.execute({kind:'input',terminalRef:'terminal.one',data:'é'.repeat(9000)});
 assert.equal(f.sent.length,0);assert.equal(f.client.snapshot().error,'terminal-input-limit');
});
