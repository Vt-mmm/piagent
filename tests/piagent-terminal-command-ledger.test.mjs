import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalCommandLedger } from '../packages/piagent-webui/gateway/terminal-command-ledger.ts';
import { controlActionDigest } from '../packages/piagent-webui/server/control-command-digest.ts';
const now=Date.parse('2026-10-23T00:00:00.000Z');
function command(key='key.one') {
 const value={schemaVersion:1,version:'piagent-terminal-v1',messageType:'command',commandId:`command.${key}`,idempotencyKey:key,
 requestedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),action:'terminal.command',
 identity:{gatewayInstanceRef:'gateway.one',sessionRef:'session.one',runtimeInstanceRef:'runtime.one'},expectedRevisions:{terminalRevision:'terminal.rev1'},
 payload:{kind:'input',terminalRef:'terminal.one',data:'echo hello\n'}};
 return {...value,actionDigest:controlActionDigest(value)};
}
function receipt(command,phase='settled') {return {schemaVersion:1,version:'piagent-terminal-v1',messageType:'receipt',commandId:command.commandId,
 idempotencyKey:command.idempotencyKey,action:command.action,actionDigest:command.actionDigest,identity:command.identity,
 observedRevisions:command.expectedRevisions,phase,terminalRef:command.payload.terminalRef,reasonCode:phase==='uncertain'?'terminal-write-uncertain':null,deduplicated:false};}
const uncertain=value=>receipt(value,'uncertain');

test('concurrent terminal retries await one effect and changed payload cannot reuse its key',async()=>{
 const ledger=new TerminalCommandLedger({now:()=>now});let calls=0,release;
 const effect=async value=>{calls++;await new Promise(resolve=>release=resolve);return receipt(value);};
 const value=command(),first=ledger.execute(value,effect,uncertain),second=ledger.execute(structuredClone(value),effect,uncertain);
 await Promise.resolve();assert.equal(calls,1);release();
 assert.equal((await first).deduplicated,false);assert.equal((await second).deduplicated,true);
 const changed=structuredClone(value);changed.payload.data='echo different\n';changed.actionDigest=controlActionDigest(changed);
 await assert.rejects(ledger.execute(changed,effect,uncertain),/terminal-idempotency-conflict/);assert.equal(calls,1);
});

test('native failure remains uncertain on retry; capacity never evicts an unexpired command',async()=>{
 let clock=now,calls=0;const ledger=new TerminalCommandLedger({limit:1,now:()=>clock});
 const effect=async()=>{calls++;throw Error('native write may have happened');};
 const value=command();assert.equal((await ledger.execute(value,effect,uncertain)).phase,'uncertain');
 const replay=await ledger.execute(value,effect,uncertain);assert.equal(replay.phase,'uncertain');assert.equal(replay.deduplicated,true);assert.equal(calls,1);
 await assert.rejects(ledger.execute(command('key.two'),effect,uncertain),/terminal-command-capacity/);
 clock=now+60001;await assert.rejects(ledger.execute(value,effect,uncertain),/terminal-command-expired/);assert.equal(calls,1);
 const next=command('key.two');next.requestedAt=new Date(clock).toISOString();next.expiresAt=new Date(clock+60000).toISOString();
 await ledger.execute(next,effect,uncertain);assert.equal(calls,2);
});
