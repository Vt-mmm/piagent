import assert from "node:assert/strict";
import test from "node:test";
import { runIndependentContract, compileIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { data } from "./helpers/async-contract-cases.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { replayCoveredContracts } from "./helpers/replay-public-coverage.mjs";
const imageId=process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID,dockerSocket=process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration={skip:!imageId||!dockerSocket,timeout:120000};
const item=(id,value,args=[])=>({id,args:args.map(data),invocation:{kind:"call"},expected:{outcome:"return",value:data(value)}});
const run=(source,cases,exportName="run")=>runIndependentContract({imageId,dockerSocket,timeoutMs:10000,
  planText:JSON.stringify({schemaVersion:2,profile:expectedNodeProfile(),source,exportName,checks:[{id:"clone-semantics",cases}]})});
const checked=(result,verdict)=>{assert.equal(result.verdict,verdict,JSON.stringify(result));assert.equal(result.execution.cleanupConfirmed,true);};

test("structuredClone profile is versioned and rejects the previous worker profile",()=>{
  assert.equal(expectedNodeProfile().workerVersion,"quickjs-node-profile-worker-v4");
  assert.throws(()=>compileIndependentContract(JSON.stringify({schemaVersion:2,profile:{...expectedNodeProfile(),workerVersion:"quickjs-node-profile-worker-v2"},
    source:"export function run(){return 1}",exportName:"run",checks:[{id:"old-profile",cases:[item("one",1)]}]})));
});

test("structuredClone copies nested input values and preserves independent reference observations",integration,async()=>{
  const input={a:[1,{label:"before"}],flag:false};
  const value=item("copy",input,[input]);value.observeArgs=true;value.expected.argsAfter=[data(input)];value.observeIdentity=true;value.expected.returnIdentity=[];
  value.referencePairs=[{id:"nested-array",left:{root:"return",path:["a"]},right:{root:"argument",index:0,path:["a"]}},
    {id:"nested-record",left:{root:"return",path:["a","1"]},right:{root:"argument",index:0,path:["a","1"]}}];
  value.expected.referenceIdentity=value.referencePairs.map(({id})=>({id,same:false}));
  checked(await run("export function run(input){return structuredClone(input)}",[value]),"pass");
  checked(await run("export function run(input){return {...input}}",[value]),"fail");
});

test("bounded clone graph semantics match native Node for aliases, cycles, sparse arrays, Dates and inert own properties",integration,async()=>{
  const source=`export function run(){
    const shared={value:1},input={a:shared,b:shared};input.self=input;
    const cloned=structuredClone(input),sparse=[];sparse.length=3;sparse[2]='last';sparse.extra='own';
    const arr=structuredClone(sparse),record=Object.create(null);
    Object.defineProperty(record,'__proto__',{value:{safe:true},enumerable:true});
    Object.defineProperty(record,'hidden',{get(){throw new Error('must not run')},enumerable:false});record[Symbol('ignored')]=1;
    const out=structuredClone(record),date=new Date(NaN),copy=structuredClone({date});
    const p=structuredClone({negativeZero:-0,infinite:Infinity,missing:undefined,big:7n});
    return cloned!==input&&cloned.a===cloned.b&&cloned.a!==shared&&cloned.self===cloned
      &&arr.length===3&&!Object.hasOwn(arr,'0')&&arr[2]==='last'&&arr.extra==='own'
      &&Object.getPrototypeOf(out)===Object.prototype&&Object.hasOwn(out,'__proto__')&&out.__proto__.safe
      &&!Object.hasOwn(out,'hidden')&&Object.getOwnPropertySymbols(out).length===0
      &&copy.date!==date&&Number.isNaN(copy.date.getTime())&&Object.is(p.negativeZero,-0)&&p.infinite===Infinity&&p.missing===undefined&&p.big===7n;
  }`;
  const native=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(native.run(),true);checked(await run(source,[item("native-parity",true)]),"pass");
});

test("clone observer uses captured intrinsics after candidate tampering",integration,async()=>{
  const source=`export function run(){const original={a:[{value:7}]};const fail=()=>{throw new Error('tampered')};
    Object.defineProperty=fail;Object.getOwnPropertyDescriptor=fail;Object.getPrototypeOf=fail;Object.hasOwn=fail;Reflect.ownKeys=fail;
    Array.isArray=fail;WeakMap.prototype.get=fail;WeakMap.prototype.set=fail;WeakMap.prototype.has=fail;
    const copy=structuredClone(original);return copy!==original&&copy.a!==original.a&&copy.a[0].value===7}`;
  checked(await run(source,[item("captured",true)]),"pass");
});

test("unsupported clone input cannot be caught and turned into a successful observation",integration,async()=>{
  for(const expression of ["{get value(){while(true){}}}","new Proxy({},{ownKeys(){while(true){}}})","new Map()","new Set()",
    "new Uint8Array([1])","new (class Value{})()","{fn(){}}","Symbol('value')","{deep:()=>7}"]){
    const source=`export function run(){try{structuredClone(${expression})}catch{}return 7}`;
    const result=await run(source,[item("unsupported",7)]);checked(result,"unknown");
    assert.equal(result.execution.observation.cases[0].outcome,"unsupported");
    assert.match(result.execution.observation.cases[0].reason,/^structured-clone-/);
  }
  checked(await run("export function run(){try{structuredClone({},{transfer:[]})}catch{}return 7}",[item("transfer",7)]),"unknown");
});

test("clone limits and realm latch stay finite across a sequence and module initialization",integration,async()=>{
  for(const expression of ["new Array(65)","'x'.repeat(4097)","Array.from({length:64},()=>({a:1,b:2,c:3,d:4}))",
    "Array.from({length:10}).reduce(value=>({value}),{})"]){
    checked(await run(`export function run(){try{structuredClone(${expression})}catch{}return 7}`,[item("limit",7)]),"unknown");
  }
  const first={...item("first",7),sequence:"history"},second={...item("second",7),sequence:"history"};
  const result=await run("let called=false;export function run(){if(!called){called=true;try{structuredClone(new Map())}catch{}}return 7}",[first,second]);
  checked(result,"unknown");assert.ok(result.execution.observation.cases.every(x=>x.outcome==="unsupported"));
  for(const prefix of ["try{structuredClone(new Map())}catch{}","structuredClone(new Map());"]){
    checked(await run(prefix+"export function run(){return 7}",[item("initialization",7)]),"unknown");
  }
});

// Literal criterion anchors select existing public witnesses; expectations stay
// outside the guest. The full SDK journey remains a separate positive gate.
const anchors=["Fix `src/data/versioned-replay.js`","Return a new state and never mutate either input.","Each event has a unique non-empty string",
  "Previously applied event ids and duplicates","A missing entity has version zero;","an accepted event must match the current version",
  "Any non-duplicate version conflict must throw","Preserve applied-event order and reject malformed","Verify","Run"];
test("unchanged replay reference executes all public behaviors and still rejects wrong conflict logic",integration,async()=>{
  const criteria=anchors.map((criterionText,i)=>({criterionText,criterionId:`test-${i}`,criterionHash:"0".repeat(64)}));
  const contract=replayCoveredContracts("idempotent-replay-conflict",criteria)[0];
  const source=productionV3ReferenceSolution("idempotent-replay-conflict")[1];
  checked(await run(source,contract.checks[0].cases,contract.exportName),"pass");
  const wrong=source.replace('if (version !== event.expectedVersion) throw new Error("version conflict");','');assert.notEqual(wrong,source);
  const result=await run(wrong,contract.checks[0].cases,contract.exportName);checked(result,"fail");
  assert.ok(result.counterexamples.some(x=>x.evidence.input.id==="partial-version-conflict"));
});
