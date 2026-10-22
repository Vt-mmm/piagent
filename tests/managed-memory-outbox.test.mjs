import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MemoryOutbox, memoryScope } from '../packages/piagent-core/managed/memory-outbox.mjs';
import { TeamMemory } from '../packages/piagent-core/managed/memory.mjs';

const scope = key => ({ origin: 'https://studio.invalid', key_id: key, user_id: 'member', studio_instance_id: 'studio', dataset_epoch: 'epoch', auth_generation: 1 });
const item = () => ({ event_id: randomUUID(), source_key_id: 'a', repo_key: 'github.com/acme/repo', conversation_id: 'conversation-1', text: 'Synthetic lesson', occurred_at: new Date().toISOString() });
const temp = t => { const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-outbox-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; };
test('outbox survives restart, scopes key and epoch, and never replays legacy JSONL', t => {
 const root=temp(t), a=new MemoryOutbox(root,scope('a')), entry=item();
 fs.writeFileSync(path.join(root,'memory-outbox.jsonl'),'unscoped legacy data');
 assert.equal(a.put(entry),true);
 assert.equal(new MemoryOutbox(root,scope('b')).files().length,0);
 assert.equal(new MemoryOutbox(root,{...scope('a'),dataset_epoch:'restored'}).files().length,0);
 const reopened=new MemoryOutbox(root,scope('a')), claim=reopened.claim(reopened.files()[0]);
 assert.deepEqual(claim.record.item,entry);reopened.finish(claim,'ack');
 assert.equal(reopened.files().length,0);assert.equal(fs.readFileSync(path.join(root,'memory-outbox.jsonl'),'utf8'),'unscoped legacy data');
});
test('only one consumer claims an event, a crashed claim expires without losing its file',t=>{
 const root=temp(t), a=new MemoryOutbox(root,scope('a')), b=new MemoryOutbox(root,scope('a'));
 a.put(item());const name=a.files()[0],claim=a.claim(name);
 assert.ok(claim);assert.equal(b.claim(name),null);assert.ok(fs.existsSync(claim.lock));
 fs.utimesSync(claim.lock,new Date(0),new Date(0));
 const recovered=b.claim(name);assert.ok(recovered);b.finish(recovered,'ack');assert.equal(a.files().length,0);
});
test('failure retains the same identity with backoff; a malformed item cannot block a good item',t=>{
 const root=temp(t);let now=Date.now();const box=new MemoryOutbox(root,scope('a'),()=>now),first=item();
 box.put(first);let claim=box.claim(box.files()[0]);box.finish(claim,'retry');assert.equal(box.claim(box.files()[0]),null);
 now+=5001;claim=box.claim(box.files()[0]);assert.equal(claim.record.item.event_id,first.event_id);box.finish(claim,'ack');
 box.put(item());const corrupt=path.join(box.directory,`${randomUUID()}.json`);fs.writeFileSync(corrupt,'{bad');
 assert.equal(box.claim(path.basename(corrupt)),null);assert.ok(fs.existsSync(corrupt+'.quarantine'));
 assert.equal(box.files().length,1);assert.ok(box.claim(box.files()[0]));
});
test('an event cannot be overwritten with another payload; files are private',t=>{
 const box=new MemoryOutbox(temp(t),scope('a')),entry=item();assert.ok(box.put(entry));assert.ok(box.put(entry));
 assert.equal(box.put({...entry,text:'changed'}),false);
 const file=path.join(box.directory,box.files()[0]);if(process.platform!=='win32')assert.equal(fs.statSync(file).mode & 0o777,0o600);
 assert.equal(memoryScope('https://s',{}),null);
});
test('a blocked backlog never blocks beforeRound and token scope changes stop replay',async t=>{
 const root=temp(t);let current=scope('a'), unblock;const calls=[];
 const memory=new TeamMemory({origin:'https://studio.invalid',cwd:root,stateDir:root,conversationId:'conversation-1',scope:()=>current,fetchImpl:async(url,init)=>{
  calls.push(JSON.parse(init.body));await new Promise(resolve=>{unblock=resolve});return new Response(JSON.stringify({status:'pending',event_id:calls.at(-1).event_id,operation_id:randomUUID()}));
 }});
 memory.repo='github.com/acme/repo';memory.protocol=2;memory.outbox.put(item());
 await memory.beforeRound({token:'a',role_id:'r'},'task',true);
 assert.equal(calls.length,1);const waiting=memory.background;current=scope('b');unblock();await waiting;
 memory.syncScope();assert.equal(memory.outbox.files().length,0);
});
test('first brief failure is retried next round, and retain opt-out preserves read capability',async t=>{
 const root=temp(t);let attempts=0;
 const memory=new TeamMemory({origin:'https://studio.invalid',cwd:root,stateDir:root,conversationId:'conversation-1',scope:()=>scope('a'),fetchImpl:async(url,init)=>{
  if(url.endsWith('/brief')){attempts++;if(attempts===1)throw Error('down');return new Response(JSON.stringify({protocol_version:2,text:'rule',pages:[],retain_sessions:true}));}
  if(url.endsWith('/retain'))return new Response(JSON.stringify({status:'retain_disabled'}));
  return new Response(JSON.stringify({text:'read still works'}));
 }});memory.repo='github.com/acme/repo';
 assert.equal(await memory.beforeRound({token:'a'},'task',false),null);
 assert.equal((await memory.beforeRound({token:'a'},'task',false)).text,'rule');
 await memory.afterRound({token:'a'},[{role:'user',content:'question'}],[]);
 assert.equal(memory.active,true);assert.equal(memory.retain,false);assert.match(await memory.search({token:'a'},'q'),/read still works/);
});

test('a stalled shared renewal cannot hold the backlog past its deadline, and a late lease is released',async t=>{
 const root=temp(t);let complete,released=0;const keepAlive=setTimeout(()=>{},7000);t.after(()=>clearTimeout(keepAlive));
 const memory=new TeamMemory({origin:'https://studio.invalid',cwd:root,stateDir:root,conversationId:'conversation-1',scope:()=>scope('a'),lease:()=>new Promise(resolve=>complete=resolve),fetchImpl:async()=>{throw Error('must not send after deadline')}});
 memory.repo='github.com/acme/repo';memory.protocol=2;memory.outbox.put(item());
 const started=Date.now();memory.startBackground({token:'old'});await memory.background;
 assert.ok(Date.now()-started<6000);assert.equal(memory.outbox.files().length,1);
 complete({grant:{token:'late'},release:()=>released++});await new Promise(resolve=>setImmediate(resolve));assert.equal(released,1);
});

test('a failed first handshake still queues the turn, then v2 confirmation drains it',async t=>{
 const root=temp(t),writes=[];let online=false;
 const memory=new TeamMemory({origin:'https://studio.invalid',cwd:root,stateDir:root,conversationId:'conversation-1',scope:()=>scope('a'),fetchImpl:async(url,init)=>{
  if(!online)throw Error('offline');const body=JSON.parse(init.body);
  if(url.endsWith('/brief'))return new Response(JSON.stringify({protocol_version:2,text:'rule',pages:[],retain_sessions:true}));
  writes.push(body.event_id);return new Response(JSON.stringify({status:'pending',event_id:body.event_id,operation_id:randomUUID()}));
 }});memory.repo='github.com/acme/repo';
 await memory.beforeRound({token:'a'},'task',false);await memory.afterRound({token:'a'},[{role:'user',content:'first turn while offline'}],[]);
 assert.equal(memory.outbox.files().length,1);assert.equal(writes.length,0);
 online=true;await memory.beforeRound({token:'a'},'next task',false);await memory.background;
 assert.equal(memory.outbox.files().length,0);assert.equal(writes.length,1);
});

test('the scope carries Studio-style lower-case key and user IDs from an upper-case manifest', () => {
  const scope = memoryScope('https://studio.invalid', { key_id: '36006E46-7893-4B75-A75B-D182DD600AC0', user: { id: '0F8103A3-0000-4000-8000-000000000001' }, authority: { studio_instance_id: 's', dataset_epoch: 'e', auth_generation: 1 } });
  assert.equal(scope.key_id, '36006e46-7893-4b75-a75b-d182dd600ac0');
  assert.equal(scope.user_id, '0f8103a3-0000-4000-8000-000000000001');
});
// 2026-10-22 audit: notes served under the old key went with the next retain
// under the new one.
test('a scope change forgets the notes served under the old scope', t => {
 const root=temp(t);let current=scope('a');
 const memory=new TeamMemory({origin:'https://studio.invalid',cwd:root,stateDir:root,conversationId:'conversation-1',scope:()=>current,fetchImpl:async()=>{throw Error('offline')}});
 const old=randomUUID();memory.serves.add('github.com/acme/repo',old);
 memory.syncScope();assert.deepEqual(memory.serves.of('github.com/acme/repo'),[old],'same scope keeps them');
 current=scope('b');memory.syncScope();
 assert.deepEqual(memory.serves.of('github.com/acme/repo'),[]);
});
