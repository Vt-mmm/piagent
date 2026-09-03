import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {projectPiagentWireInput, registerInputHook} from '../packages/piagent-core/runtime/hooks/input-hook.ts';
import {RuntimeSessionState} from '../packages/piagent-core/runtime/session/runtime-state.ts';
import {PIAGENT_TOOL_ORDER} from '../packages/piagent-core/runtime/tools/tool-groups.ts';
const task = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/task-contract.valid.json',import.meta.url),'utf8'));
const cases = [
  {id:'image-attachment-unfrozen',text:'./fixture.png',pressure:0,want:'transform',image:true},
  {id:'ordinary-short-positive', text:'Inspect the current plan.', pressure:0, want:'continue'},
  {id:'governed-boilerplate',text:'Mandatory flow piagent_context piagent_task_start output format\nPlan task: ```text\nInspect the current plan.\n```\n' + 'public fixture context '.repeat(40),pressure:0,want:'transform'},
  {id:'known-workflow-high-pressure',text:'/scout Inspect the current plan.',pressure:95,want:'transform'}
];
for (const row of cases) test(row.id, async(t) => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-input-projection-'));
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 if(row.image){const png=Buffer.alloc(24);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);fs.writeFileSync(path.join(cwd,'fixture.png'),png);}
 const active={...structuredClone(task),sessionId:'parity-session'}, handlers=new Map(), groups=[];
 const ctx={cwd,mode:'rpc',model:{provider:'openai-codex',id:'gpt-5.6-luna'},ui:{notify(){}},
  getContextUsage:()=>({tokens:row.pressure*1000,contextWindow:100000,percent:row.pressure}),
  sessionManager:{getSessionId:()=>active.sessionId,getSessionFile:()=>undefined,getSessionName:()=>undefined,getEntries:()=>[],getBranch:()=>[]}};
 const pi={on:(name,handler)=>handlers.set(name,handler),getThinkingLevel:()=> 'medium'};
 registerInputHook(pi,{state:new RuntimeSessionState({maxObservedContext:2}),boilerplateCollapseChars:300,
  activeTask:()=>active,authorityPolicy:()=>({disposition:'allow'}),readProtectedPaths:()=>[],
  imageAccess:()=>row.image?{roots:[{path:fs.realpathSync(cwd),source:'project'}],readProtectedPaths:[],enforceFilesystemRead:false}:assert.fail('no images expected'),activateToolGroups:(_ctx,value)=>groups.push(value),telemetry(){}});
 const projection=projectPiagentWireInput({text:row.text,source:'rpc',activeTask:active,readProtectedPaths:[],
  currentTools:['read','write','edit','apply_patch'], availableToolNames:['read','write','edit','apply_patch',...PIAGENT_TOOL_ORDER],
  dynamicToolsEnabled:true,replacementIntake:false,hasImages:false,phase:'intake'});
 const actual=await handlers.get('input')({text:row.text,source:'rpc',images:[]},ctx);

 assert.equal(actual.action,row.want,'actual hook behavior reaches intended branch');
 if(row.want==='continue') {assert.equal(projection.disposition,'known');assert.deepEqual(projection.groups,groups[0]);}
 else assert.equal(projection.disposition,'blocked','unprojected transforms must not be known');
});

test('image state must be explicitly frozen empty',()=>{
 const input={text:'Inspect the current plan.',source:'rpc',activeTask:task,readProtectedPaths:[],currentTools:[],availableToolNames:[...PIAGENT_TOOL_ORDER],dynamicToolsEnabled:true,replacementIntake:false,phase:'intake'};
 for(const hasImages of [undefined,true]) assert.deepEqual(projectPiagentWireInput({...input,hasImages}),{disposition:'blocked',reason:'input-images-unprojected'});
 assert.equal(projectPiagentWireInput({...input,hasImages:false}).disposition,'known');
});
