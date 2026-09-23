import assert from "node:assert/strict";
import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import { data } from "./async-contract-cases.mjs";

// Finite, reviewed public witnesses from production-journey-backend-transport.
// The expected outputs are independent constants. No registered grader/oracle
// or implementation-derived answer is used by these approved host contracts.
const result = (id,args,value) => ({id,args:args.map(data),invocation:{kind:"call"},observeArgs:true,
  expected:{outcome:"return",value:data(value),argsAfter:args.map(data)}});
const invalid = (id,args) => ({id,args:args.map(data),invocation:{kind:"call"},observeArgs:true,
  expected:{outcome:"throw",errorClass:"TypeError",argsAfter:args.map(data)}});
function tenant() {
  const user={active:true,role:"owner",tenantId:"north"},resource={tenantId:"north"};
  const allow=[result("owner",[user,resource],true),result("admin",[{...user,role:"admin"},resource],true)];
  const deny=[result("cross-tenant-owner",[user,{tenantId:"south"}],false),
    result("cross-tenant-admin",[{...user,role:"admin",tenantId:"south"},resource],false)];
  for(const role of ["owner","admin"])deny.push(result(`inactive-${role}`,[{...user,active:false,role},resource],false));
  for(const [i,role] of ["member","viewer","",null,undefined].entries())deny.push(result(`other-role-${i}`,[{...user,role},resource],false));
  const missing=[result("no-arguments",[],false)];
  for(const [i,value] of [null,undefined].entries())missing.push(result(`missing-user-${i}`,[value,resource],false),result(`missing-resource-${i}`,[user,value],false));
  missing.push(result("missing-user-tenant",[{active:true,role:"owner"},resource],false),result("missing-resource-tenant",[user,{}],false));
  for(const [i,value] of ["",7,{id:"north"},["north"]].entries())missing.push(result(`invalid-matching-id-${i}`,[{...user,tenantId:value},{tenantId:value}],false));
  const all=[...allow,...deny,...missing];
  return {exportName:"canManage",sourcePath:"src/backend/auth.js",count:6,groups:[[0,all],[1,all],[2,missing],[5,all]],
    anchors:[[0,"Fix `src/backend/auth.js` without changing its exported API."],[1,"`canManage(user, resource)` may return true only"],[2,"Missing input must be denied."],[5,"Focused tests prove every requested allow path"]]};
}
function revocation() {
  const entry=(changes={})=>({tenantId:"north",userId:"user-1",capability:"edit",permissionRevision:3,evaluatedAt:10,expiresAt:20,...changes});
  const request=(changes={})=>({tenantId:"north",userId:"user-1",capability:"edit",currentPermissionRevision:3,now:10,revokedAt:null,...changes});
  const window=[[10,true],[19,true],[20,false],[21,false]].map(([now,value])=>result(`expiry-${now}`,[entry(),request({now})],value));
  window.push(result("evaluation-in-future",[entry({evaluatedAt:11}),request()],false),
    result("negative-finite-integers",[entry({permissionRevision:-1,evaluatedAt:-2,expiresAt:1}),request({currentPermissionRevision:-1,now:0})],true));
  const matching=[["tenantId","south"],["userId","user-2"],["capability","delete"],["currentPermissionRevision",4]]
    .map(([field,value])=>result(`mismatch-${field}`,[entry(),request({[field]:value})],false));
  const revoked=[[9,false],[10,false],[11,true],[null,true]].map(([revokedAt,value])=>result(`revoked-${revokedAt}`,[entry(),request({revokedAt})],value));
  const malformed=[];
  for(const [i,value] of [null,undefined,[],1,"entry",{}].entries())malformed.push(invalid(`entry-shape-${i}`,[value,request()]),invalid(`request-shape-${i}`,[entry(),value]));
  for(const field of ["tenantId","userId","capability"])for(const [i,value] of ["",null,1,undefined].entries())malformed.push(
    invalid(`entry-${field}-${i}`,[entry({[field]:value}),request()]),invalid(`request-${field}-${i}`,[entry(),request({[field]:value})]));
  const numbers=[],revokedInvalid=[];
  for(const [i,value] of [NaN,Infinity,-Infinity,0.25,"10",null,undefined].entries()) {
    for(const field of ["permissionRevision","evaluatedAt","expiresAt"])numbers.push(invalid(`entry-${field}-${i}`,[entry({[field]:value}),request()]));
    for(const field of ["currentPermissionRevision","now"])numbers.push(invalid(`request-${field}-${i}`,[entry(),request({[field]:value})]));
    if(value!==null)revokedInvalid.push(invalid(`revoked-invalid-${i}`,[entry(),request({revokedAt:value})]));
  }
  const all=[...window,...matching,...revoked,...malformed,...numbers,...revokedInvalid];
  return {exportName:"isCachedAccessUsable",sourcePath:"src/backend/revocation-cache.js",count:12,
    groups:[[0,all],[1,[...matching,...malformed]],[2,[matching[3],window[5]]],[3,window],[4,window],[5,revoked],
      [6,numbers],[7,[...revoked,...revokedInvalid]],[8,[...malformed,...numbers,...revokedInvalid]],[9,all]],
    anchors:[[0,"Fix `src/backend/revocation-cache.js` without changing its exported API."],[1,"`isCachedAccessUsable(entry, request)` must return true only"],
      [2,"the cached permission revision equals"],[3,"evaluation is not in the future;"],[4,"and `request.now` is strictly before"],
      [5,"A revocation at or before"],[6,"Validate all time and revision fields as finite integers;"],
      [7,"`request.revokedAt` must be either null or a finite integer."],[8,"Throw `TypeError` for malformed input."],[9,"Do not mutate either argument."]]};
}
function invoice() {
  const valid=[result("default-quantity",[[{unitCents:101}]],101),result("quantity-three",[[{unitCents:101,quantity:3}]],303),
    result("empty",[[]],0),result("multiply-discount-round",[[{unitCents:101,quantity:3,discountBps:2500}]],227),
    result("round-each-line",[[{unitCents:1,discountBps:5000},{unitCents:1,discountBps:5000}]],2),
    result("tax-on-sum",[[{unitCents:1},{unitCents:1},{unitCents:1}],5000],5),
    result("discount-and-tax",[[{unitCents:199,quantity:2,discountBps:1250}],825],377),
    result("zero-money",[[{unitCents:0,quantity:1,discountBps:0}],0],0),
    result("max-discount",[[{unitCents:99,quantity:1,discountBps:10000}],10000],0),
    result("max-tax",[[{unitCents:101,quantity:1,discountBps:0}],10000],202)];
  const money=[],bps=[];
  for(const [i,unitCents] of [-1,0.5,NaN,Infinity,"1",null].entries())money.push(invalid(`unit-${i}`,[[{unitCents,quantity:1}]]));
  for(const [i,quantity] of [0,-1,0.5,NaN,Infinity,"1"].entries())money.push(invalid(`quantity-${i}`,[[{unitCents:1,quantity}]]));
  for(const [i,value] of [-1,10001,0.5,NaN,Infinity,"1"].entries())bps.push(invalid(`discount-${i}`,[[{unitCents:1,discountBps:value}]]),invalid(`tax-${i}`,[[{unitCents:1}],value]));
  const all=[...valid,...money,...bps];
  return {exportName:"invoiceTotalCents",sourcePath:"src/backend/invoice.js",count:9,
    groups:[[0,all],[1,[...valid,...money,...bps]],[2,valid.slice(0,5)],[3,valid.slice(4)],[4,money],[5,[...valid.slice(7),...bps]],[6,all]],
    anchors:[[0,"Repair `invoiceTotalCents(lines, taxBps)`"],[1,"All values are integer cents or basis points."],
      [2,"For each line, multiply"],[3,"Sum the line totals, apply"],[4,"Reject negative/non-integer money"],[5,"also reject discount or tax basis points"],[6,"Do not change the exported API."]]};
}
function billing() {
  const period=(changes={})=>({startsAt:10,endsAt:20,maxClockSkewMs:2,...changes});
  const event=(changes={})=>({occurredAt:10,receivedAt:10,...changes});
  const window=[result("outside-before",[event({occurredAt:9}),period()],"outside"),result("start-inclusive",[event(),period()],"current"),
    result("inside-before-end",[event({occurredAt:19,receivedAt:19}),period()],"current"),result("end-exclusive",[event({occurredAt:20,receivedAt:20}),period()],"outside")];
  const skew=[[8,"current"],[7,"invalid-clock"],[21,"current"],[22,"late"],[23,"late"]]
    .map(([receivedAt,value])=>result(`receipt-${receivedAt}`,[event({receivedAt}),period()],value));
  skew.push(result("zero-skew-clock",[event({receivedAt:9}),period({maxClockSkewMs:0})],"invalid-clock"),
    result("zero-skew-late",[event({receivedAt:20}),period({maxClockSkewMs:0})],"late"));
  const precedence=[result("outside-before-clock",[event({occurredAt:9,receivedAt:0}),period()],"outside"),
    result("outside-before-late",[event({occurredAt:20,receivedAt:100}),period()],"outside"),
    result("negative-integer-times",[{occurredAt:-5,receivedAt:-5},{startsAt:-10,endsAt:0,maxClockSkewMs:0}],"current")];
  const malformed=[];
  for(const [i,value] of [NaN,Infinity,-Infinity,0.5,"10",null,undefined].entries()) {
    for(const field of ["occurredAt","receivedAt"])malformed.push(invalid(`event-${field}-${i}`,[event({[field]:value}),period()]));
    for(const field of ["startsAt","endsAt","maxClockSkewMs"])malformed.push(invalid(`period-${field}-${i}`,[event(),period({[field]:value})]));
  }
  malformed.push(invalid("negative-skew",[event(),period({maxClockSkewMs:-1})]),invalid("equal-period",[event(),period({endsAt:10})]),invalid("decreasing-period",[event(),period({endsAt:9})]));
  for(const [i,value] of [null,undefined,1,"",{}].entries())malformed.push(invalid(`event-shape-${i}`,[value,period()]),invalid(`period-shape-${i}`,[event(),value]));
  const all=[...window,...skew,...precedence,...malformed];
  return {exportName:"billingBucket",sourcePath:"src/backend/billing-window.js",count:11,
    groups:[[0,all],[1,window],[2,[...window,...precedence]],[3,skew],[4,skew],[5,[...window,...skew,...precedence]],[6,malformed],[7,malformed],[8,all]],
    anchors:[[0,"Fix `src/backend/billing-window.js` while preserving"],[1,"The billing period is half-open:"],[2,"Return `outside` for an occurrence"],
      [3,"For an in-period event, return `invalid-clock`"],[4,"return `late` when receipt"],[5,"otherwise return `current`."],
      [6,"All timestamps and the skew must be finite integers"],[7,"malformed values throw `TypeError`."],[8,"Inputs must remain unchanged."]]};
}
const families={"billing-cutoff-clock-skew":billing,"tenant-role-authorization":tenant,"revoked-session-cache":revocation,"invoice-rounding":invoice};
export function backendCoveredContracts(id,criteria) {
  const family=families[id]();assert.equal(criteria.length,family.count);
  for(const [i,text] of family.anchors)assert.ok(criteria[i].criterionText.startsWith(text),`${id} criterion ${i+1} changed`);
  return addPublicApiCoverage(family.groups.map(([i,cases])=>({route:"code",criterionId:criteria[i].criterionId,criterionHash:criteria[i].criterionHash,
    sourcePath:family.sourcePath,exportName:family.exportName,maxAttempts:1,checks:[{id:`backend-public-${i+1}`,cases}]})));
}
