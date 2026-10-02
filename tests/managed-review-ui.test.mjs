import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {managedProjection} from '../packages/piagent-webui/gateway/managed-projection.ts';
import {sandboxDiagnostic} from '../packages/piagent-core/managed/sandbox-diagnostic.mjs';
import {nativeThinkingLevels,managedThinkingLevels} from '../packages/piagent-core/managed/capabilities.mjs';
import {piagentInstallations} from '../scripts/piagent-installations.mjs';

test('managed projection masks native label and has current helper/capability state',()=>{
 const out=managedProjection({model:{provider:'agent_watch_managed',modelId:'private-native'}},[
  {type:'custom',customType:'agent-watch-helpers',data:{active:1}},
  {type:'custom',customType:'agent-watch-helpers',data:{active:2}},
  {type:'custom',customType:'agent-watch-model',data:{managedThinkingLevels:['low','medium','high','fake'],name:'secret-route'}}]);
 assert.equal(out.modelLabel,'agent-watch-auto');assert.equal(out.managedHelpers.active,2);
 assert.deepEqual(out.managedThinkingLevels,['low','medium','high']);assert.doesNotMatch(JSON.stringify(out),/secret-route|private-native/);
 assert.deepEqual(managedProjection({model:{provider:'openai-codex'}},[]),{});
});
test('thinking choices intersect enabled helper capabilities without editing native context',()=>{
 const main={reasoning:true,contextWindow:1000000,thinkingLevelMap:{off:null,minimal:null,max:'max',xhigh:'xhigh'}};
 const helper={reasoning:true,thinkingLevelMap:{off:null,minimal:null,xhigh:null,max:null}};
 const runtime={getModel:(_,id)=>id==='main'?main:helper};
 const manifest={models:[{id:'m',owned_by:'claude',provider_model_id:'main'},{id:'h',owned_by:'codex',provider_model_id:'helper'}],harness:{configuration:{main:{model_ids:['m']},research:{model_ids:['h']},review:null}}};
 assert.deepEqual(nativeThinkingLevels(main),['low','medium','high','xhigh','max']);
 assert.deepEqual(managedThinkingLevels(manifest,runtime,main),['low','medium','high']);assert.equal(main.contextWindow,1000000);
});
test('sandbox denial has actionable reason, ordinary tool failures are not mislabelled',()=>{
 assert.match(sandboxDiagnostic('EPERM: operation not permitted'),/^managed-sandbox-denied/);
 assert.equal(sandboxDiagnostic('build ok'),'build ok');
 assert.equal(sandboxDiagnostic('SyntaxError: missing brace'),'SyntaxError: missing brace');
 // Offline plain bash points to run_with_network; an approved network command that still cannot resolve does not ask again.
 assert.match(sandboxDiagnostic('npm error code ENOTFOUND'),/^managed-network-blocked:.*run_with_network/);
 assert.match(sandboxDiagnostic('npm error code ENOTFOUND',{network:true}),/^managed-network-unreachable:.*Không xin duyệt lại/);
});
test('doctor distinguishes same-version old installations without executing them',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pi-installations-'));
 try{
  for(const [index,prefix] of ['.local','.pi/npm-global'].entries()){
   const root=path.join(home,prefix,'lib/node_modules/@piagent/platform');fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
   fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@piagent/platform',version:'1.8.0'}));
   fs.writeFileSync(path.join(root,'scripts/piagent-cli.mjs'),'throw Error("must not run")');
   if(index===0)fs.writeFileSync(path.join(root,'scripts/piagent-studio.mjs'),'managed-v1');
   const bin=path.join(home,prefix,'bin');fs.mkdirSync(bin,{recursive:true});fs.symlinkSync(path.join(root,'scripts/piagent-cli.mjs'),path.join(bin,'piagent'));
  }
  const found=piagentInstallations({home,searchPath:'',systemRoots:[]});assert.equal(found.length,2);assert.equal(found.filter(i=>i.managed).length,1);
  assert.notEqual(found[0].fingerprint,found[1].fingerprint);
 }finally{fs.rmSync(home,{recursive:true,force:true})}
});
