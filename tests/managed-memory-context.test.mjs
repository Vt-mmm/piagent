import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { piSdkRoot } from './helpers/pi-sdk.mjs';
import { MEMORY_ENTRY, openRound, closeRound, prepareMemoryContext, hasBrief } from '../packages/piagent-core/managed/memory.mjs';
import { scopeID, memoryScope } from '../packages/piagent-core/managed/memory-outbox.mjs';
const sdkFile = path.join(piSdkRoot(), 'dist/core/session-manager.js');
const SessionManager = fs.existsSync(sdkFile) ? (await import(pathToFileURL(sdkFile))).SessionManager : null;
const user = text => ({role:'user',content:text,timestamp:Date.now()});
const answer = text => ({role:'assistant',content:[{type:'text',text}],timestamp:Date.now()});
function fixture() {
 const manager=SessionManager.inMemory('/tmp'), requests=[], retained=[];
 const self={origin:'https://studio.invalid',grant:{token:'synthetic'},ownPaths:[],manifest:{key_id:'key-a',user:{id:'member'},authority:{studio_instance_id:'studio',dataset_epoch:'epoch',auth_generation:1}}};
 self.memory={stats:{},active:true,count(k){this.stats[k]=(this.stats[k]??0)+1},scope:()=>memoryScope(self.origin,self.manifest),syncScope(){this.scopeHash=scopeID(this.scope())},startBackground(){},async beforeRound(_g,prompt){requests.push(prompt);return {text:`RULE_${requests.length}`,facts:1,pages:[]}},async reportTurn(){},async afterRound(...args){retained.push(args)}};
 self.session={sessionManager:manager,get messages(){return manager.buildSessionContext().messages},async sendCustomMessage(m){manager.appendCustomMessageEntry(m.customType,m.content,false,m.details)}};
 return {self,manager,requests,retained};
}
test('successful compaction refreshes before the next model and retain uses branch entry IDs',{skip:!SessionManager},async()=>{
 const {self,manager,requests,retained}=fixture();
 for(let i=0;i<20;i++)manager.appendMessage(user(`old ${i}`));
 await openRound(self,manager,'Implement a durable invoice total with integer cents');
 manager.appendMessage(user('Implement a durable invoice total with integer cents'));
 const kept=manager.appendMessage(answer('Final answer before compaction'));
 manager.appendCompaction('synthetic summary',kept,10000);
 assert.equal(hasBrief(manager),false);
 const prepared=await prepareMemoryContext(self,self.session.messages);
 assert.equal(requests.length,2);assert.match(requests[1],/invoice total/);
 assert.equal(prepared.filter(m=>m.customType===MEMORY_ENTRY).length,1);assert.match(prepared[0].content,/RULE_2/);
 await prepareMemoryContext(self,self.session.messages);assert.equal(requests.length,2);
 await closeRound(self);assert.equal(retained.length,1);
 assert.match(JSON.stringify(retained[0][1]),/Final answer before compaction/);assert.doesNotMatch(JSON.stringify(retained[0][1]),/synthetic summary|RULE_/);
 assert.equal(retained[0][3].id,self.memoryTurn.id);
});
test('failed compaction does not refresh; a retained old brief is replaced after successful compaction',{skip:!SessionManager},async()=>{
 const {self,manager,requests}=fixture();await openRound(self,manager,'Task');
 const briefEntry=manager.getBranch().find(e=>e.type==='custom_message');
 await prepareMemoryContext(self,self.session.messages);assert.equal(requests.length,1);
 manager.appendCompaction('summary',briefEntry.id,1000);
 const prepared=await prepareMemoryContext(self,self.session.messages);assert.equal(requests.length,2);
 assert.equal(prepared.filter(m=>m.customType===MEMORY_ENTRY).length,1);assert.match(prepared[0].content,/RULE_2/);
});
test('resume and key changes do not reuse unscoped or another key brief',{skip:!SessionManager},async()=>{
 const {self,manager,requests}=fixture();manager.appendCustomMessageEntry(MEMORY_ENTRY,'LEGACY',false,{});
 await openRound(self,manager,'First');await prepareMemoryContext(self,self.session.messages);
 self.manifest.key_id='key-b';await openRound(self,manager,'New key');
 const prepared=await prepareMemoryContext(self,self.session.messages);
 assert.equal(requests.length,2);assert.equal(prepared.filter(m=>m.customType===MEMORY_ENTRY).length,1);
 assert.doesNotMatch(prepared[0].content,/LEGACY|RULE_1/);
});
test('branching away from a cached refresh cannot leak that branch into a new task',{skip:!SessionManager},async()=>{
 const {self,manager,requests}=fixture();const fork=manager.appendMessage(user('base'));
 await openRound(self,manager,'branch A task');manager.appendMessage(answer('A only'));
 manager.branch(fork);await openRound(self,manager,'branch B task');
 const prepared=await prepareMemoryContext(self,self.session.messages);
 assert.equal(requests.length,2);assert.doesNotMatch(JSON.stringify(prepared),/A only|RULE_1/);
});
test('an empty or failed brief is not asked again every round of the same context',{skip:!SessionManager},async()=>{
 const {self,manager,requests}=fixture();self.memory.protocol=2;
 self.memory.beforeRound=async(_g,prompt)=>{requests.push(prompt);self.memory.lastBrief='empty';return {text:'',facts:0,pages:[]};};
 for(const t of ['first task','second task','third task'])await openRound(self,manager,t);
 assert.equal(requests.length,1);
 // A new context (successful compaction) asks again.
 const kept=manager.appendMessage(answer('done'));manager.appendCompaction('summary',kept,1000);
 await prepareMemoryContext(self,self.session.messages);assert.equal(requests.length,2);
 const failing=fixture();failing.self.memory.protocol=2;
 failing.self.memory.beforeRound=async(_g,prompt)=>{failing.requests.push(prompt);failing.self.memory.lastBrief='error';return null;};
 await openRound(failing.self,failing.manager,'one');await openRound(failing.self,failing.manager,'two');
 assert.equal(failing.requests.length,1);
 // Before the first handshake the outbox cannot drain, so a failed brief is asked again next round.
 const fresh=fixture();fresh.self.memory.protocol=0;
 fresh.self.memory.beforeRound=async(_g,prompt)=>{fresh.requests.push(prompt);fresh.self.memory.lastBrief='error';return null;};
 await openRound(fresh.self,fresh.manager,'one');await openRound(fresh.self,fresh.manager,'two');
 assert.equal(fresh.requests.length,2);
});
