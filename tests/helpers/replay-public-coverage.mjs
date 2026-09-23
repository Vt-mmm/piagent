import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import assert from "node:assert/strict";
import { data } from "./async-contract-cases.mjs";
const state=()=>({entities:{},appliedEventIds:[]});
const event=(changes={})=>({eventId:"first",entityId:"entity",expectedVersion:0,nextValue:{count:1},...changes});
const result=(id,args,value)=>({id,args:args.map(data),invocation:{kind:"call"},observeArgs:true,observeIdentity:true,
  expected:{outcome:"return",value:data(value),argsAfter:args.map(data),returnIdentity:[]}});
const invalid=(id,args,conflict=false)=>({id,args:args.map(data),invocation:{kind:"call"},observeArgs:true,
  ...(conflict?{observeErrorMessage:true}:{}),expected:{outcome:"throw",errorClass:conflict?"Error":"TypeError",argsAfter:args.map(data),
    ...(conflict?{errorMessage:{includes:"version conflict",ignoreCase:false}}:{})}});
// Same public request witnesses as production-journey-data-transport. A reset
// reuses only the observed first result, not a hand-authored substitute state.
export function replayCoveredContracts(_id,criteria){
  assert.equal(criteria.length,10);
  const anchors=["Fix `src/data/versioned-replay.js`","Return a new state and never mutate either input.","Each event has a unique non-empty string",
    "Previously applied event ids and duplicates","A missing entity has version zero;","an accepted event must match the current version",
    "Any non-duplicate version conflict must throw","Preserve applied-event order and reject malformed"];
  anchors.forEach((text,i)=>assert.ok(criteria[i].criterionText.startsWith(text)));
  const once={entities:{entity:{version:1,value:{count:1}}},appliedEventIds:["first"]};
  const twice={entities:{entity:{version:2,value:{count:2}}},appliedEventIds:["first","second"]};
  const advance=result("new-entity-and-order",[state(),[event(),event({eventId:"second",expectedVersion:1,nextValue:{count:2}})]],twice);
  advance.referencePairs=[{id:"new-entities",left:{root:"return",path:["entities"]},right:{root:"argument",index:0,path:["entities"]}},
    {id:"copied-event-value",left:{root:"return",path:["entities","entity","value"]},right:{root:"argument",index:1,path:["1","nextValue"]}}];
  advance.expected.referenceIdentity=advance.referencePairs.map(({id})=>({id,same:false}));
  const duplicate=result("duplicate-in-replay",[state(),[event(),event()]],once);duplicate.sequence="repeat";
  const previous=result("previously-applied",[once,[event()]],once);previous.sequence="repeat";previous.reset=true;
  previous.args[0]={type:"result",value:"duplicate-in-replay"};
  const conflicts=[invalid("partial-version-conflict",[state(),[event(),event({eventId:"conflicting",expectedVersion:0})]],true)];
  const malformed=[...[null,[],{},{entities:null,appliedEventIds:[]},{entities:{},appliedEventIds:""},{entities:{},appliedEventIds:[""]}]
    .map((input,i)=>invalid(`state-shape-${i}`,[input,[]])),
    ...[null,[],{},event({eventId:""}),event({eventId:1}),event({entityId:""}),event({entityId:null}),event({expectedVersion:0.5}),event({expectedVersion:"0"})]
      .map((value,i)=>invalid(`event-shape-${i}`,[state(),[value]]))];
  const all=[advance,duplicate,previous,...conflicts,...malformed];
  return addPublicApiCoverage([all,all,malformed,[duplicate,previous],[advance],[advance,...conflicts],conflicts,[advance,...malformed]].map((cases,i)=>({route:"code",
    criterionId:criteria[i].criterionId,criterionHash:criteria[i].criterionHash,sourcePath:"src/data/versioned-replay.js",exportName:"replayVersionedEvents",maxAttempts:1,
    checks:[{id:`replay-public-${i+1}`,cases}]})));
}
