import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { DECLARED_API_VERSION, observeDeclaredApi, validateDeclaredApi } from "../packages/piagent-core/extensions/acceptance-declared-api.js";
import { compileIndependentContract, compareIndependentExecution, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
const api=(parameters=["required","required"])=>({version:DECLARED_API_VERSION,exports:[{name:"sum",kind:"function",async:false,generator:false,parameters}]});
const fixture=(source="export function sum(a,b){return a+b}",publicApi=api())=>({schemaVersion:2,profile:expectedNodeProfile(),source,exportName:"sum",
  checks:[{id:"api-and-behavior",cases:[{id:"sum",args:[{type:"number",value:2},{type:"number",value:3}],invocation:{kind:"call"},
    expected:{outcome:"return",value:{type:"number",value:5},publicApi}}]}]});
const compile=value=>compileIndependentContract(JSON.stringify(value));

test("declared API opt-in is host-only, versioned, bounded and absent from guest requests",()=>{
  const compiled=compile(fixture());assert.equal(compiled.version,"bounded-node-profile-contract-comparison-v3");
  assert.equal(compiled.requestText.includes("publicApi"),false);assert.equal(compiled.requestText.includes(DECLARED_API_VERSION),false);
  const legacy=fixture();legacy.schemaVersion=1;delete legacy.profile;delete legacy.checks[0].cases[0].invocation;
  assert.throws(()=>compile(legacy));
  for(const change of [x=>x.version="unknown",x=>x.exports=[],x=>x.exports.push(x.exports[0]),x=>x.exports[0].name=null,
    x=>x.exports[0].parameters=["rest"],x=>x.exports[0].parameters=Array(17).fill("required"),x=>x.exports[0].async="false",
    x=>x.exports[0].parameters=[{kind:"default",value:{type:"callback",value:"unapproved"}}]]){
    const bad=api();change(bad);assert.throws(()=>validateDeclaredApi(bad));
  }
});

test("declarations distinguish arity, default value, async/generator, removed/added export and const freezing",()=>{
  assert.deepEqual(observeDeclaredApi("export function sum(left,right){for(let i=0;i<2;i++){}return [left,right].reduce((a,b)=>a+b,0)}").value,api());
  for(const source of ["export function sum(a,b,c){return a+b}","export function sum(a,b=0){return a+b}",
    "export async function sum(a,b){return a+b}","export function* sum(a,b){yield a+b}","export function renamed(a,b){return a+b}",
    "export function sum(a,b){return a+b}export const extra=1"]){
    const result=observeDeclaredApi(source);assert.equal(result.status,"observed");assert.notDeepEqual(result.value,api());
  }
  const base=observeDeclaredApi("export const initial=Object.freeze({items:[]});export function sum(a,b=initial){return a+b}");
  assert.equal(base.status,"observed");
  for(const source of ["export const initial={items:[]};export function sum(a,b=initial){return a+b}",
    "export const initial=Object.freeze({items:[1]});export function sum(a,b=initial){return a+b}"]){assert.notDeepEqual(observeDeclaredApi(source).value,base.value);}
  assert.equal(observeDeclaredApi("export function sum(a,b={}){return a+b}").status,"observed");
  const privateDefault=observeDeclaredApi("const fallback=0;export function sum(a,b=fallback){return a+b}");
  assert.notDeepEqual(observeDeclaredApi("const fallback=1;export function sum(a,b=fallback){return a+b}").value,privateDefault.value);
});

test("unsupported declaration shapes never execute initializers or become evidence",()=>{
  for(const source of ["globalThis.sideEffect=1;export function sum(a,b){return a+b}","export function sum(...args){return 5}",
    "export default function sum(a,b){return a+b}","export {sum} from './module.mjs'", "export let sum=(a,b)=>a+b",
    "export const initial=(()=>{while(true){}})();export function sum(a,b){return 5}",
    "export function sum(a,b){sum=()=>5;return a+b}","export function sum(a,b=Date.now()){return a+b}"]){
    assert.equal(observeDeclaredApi(source).status,"unsupported");
  }
});

test("pure comparison recomputes API declarations from bound source and cannot trust guest metadata",()=>{
  const good=compile(fixture()),bad=compile(fixture("export function sum(a,b,c){return a+b}"));
  const execution={status:"completed",cleanupConfirmed:true,runId:"diagnostic",sourceDigest:"source",imageId:"image",
    observation:{cases:[{id:"sum",outcome:"return",value:{type:"number",value:5},publicApi:api()}]}};
  assert.equal(compareIndependentExecution(good,execution).verdict,"pass");
  const result=compareIndependentExecution(bad,execution);assert.equal(result.verdict,"fail");
  assert.equal(result.counterexamples[0].evidence.observed.publicApi.exports[0].parameters.length,3);
  const unsupported=compile(fixture("export const sum=(...values)=>values.reduce((a,b)=>a+b,0)"));
  assert.equal(compareIndependentExecution(unsupported,execution).verdict,"unknown");
});

test("public schema exposes declared API only in the Node contract and rejects malformed declarations",()=>{
  const schema=JSON.parse(fs.readFileSync(new URL('../schemas/approved-host-contracts.schema.json',import.meta.url)));
  const ajv=new Ajv({strict:false,allErrors:true});ajv.addSchema(schema);
  const current=ajv.compile({$ref:schema.$id+'#/$defs/expectedV2'}),legacy=ajv.compile({$ref:schema.$id+'#/$defs/expected'});
  const expected=fixture().checks[0].cases[0].expected;assert.equal(current(expected),true,JSON.stringify(current.errors));assert.equal(legacy(expected),false);
  const bad=structuredClone(expected);bad.publicApi.exports[0].parameters=["rest"];assert.equal(current(bad),false);
});

const imageId=process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID,dockerSocket=process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration={skip:!imageId||!dockerSocket,timeout:60000};
test("actual isolated execution keeps body failures, declaration failures and unsupported cases separate",integration,async()=>{
  for(const [source,verdict] of [["export function sum(a,b){return [a,b].reduce((x,y)=>x+y,0)}","pass"],
    ["export function sum(a,b,c){return a+b}","fail"],["export function sum(a,b){return a-b}","fail"],
    ["export function sum(...args){return args[0]+args[1]}","unknown"]]){
    const result=await runIndependentContract({imageId,dockerSocket,planText:JSON.stringify(fixture(source))});
    assert.equal(result.verdict,verdict,JSON.stringify(result));assert.equal(result.execution.cleanupConfirmed,true);
    assert.equal(JSON.stringify(result.execution.observation).includes("publicApi"),false);
  }
});
