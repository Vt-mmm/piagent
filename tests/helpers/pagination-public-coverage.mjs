import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import assert from "node:assert/strict";
import { data } from "./async-contract-cases.mjs";
const returned = (id, args, value) => ({ id, args: args.map(data), invocation: { kind: "call" }, expected: { outcome: "return", value: data(value) } });
const rejected = (id, args) => ({ id, args: args.map(data), invocation: { kind: "call" }, expected: { outcome: "throw", errorClass: "TypeError" } });

// Reviewed public witnesses already used by production-journey-source and
// A-v2 Number calibration. Expected large results are explicit, not computed
// with the implementation expression under test.
export function paginationCoveredContracts(criteria) {
  assert.equal(criteria.length, 8);
  const anchors = ["Correct `src/frontend/pagination.js`.", "`pageCount(totalItems, pageSize)` must return `Math.ceil(totalItems / pageSize)`",
    "`clampPage` returns zero", "otherwise it clamps an integer page", "`clampPage` must reject", "do not round or coerce it."];
  anchors.forEach((anchor, i) => assert.ok(criteria[i].criterionText.startsWith(anchor)));
  assert.equal(criteria[6].criterionText, "Keep the API and verify the project.");
  const count = [[0,5,0],[10,5,2],[11,5,3],[2**53,1,2**53],[1,2**53,1],
    [2**54,3,6004799503160661],[2**55,3,12009599006321322]]
    .map(([a,b,value],i) => returned(`count-${i}`, [a,b],value));
  const clamp = [[2**54,2**54,3,6004799503160661],[2**55,2**55,3,12009599006321322],
    [-4,0,5,0],[-4,10,5,1],[0,10,5,1],[1,10,5,1],[2,15,5,2],[2,10,5,2],[3,10,5,2],
    [9,10,5,2],[2**53,10,5,2],[-(2**53),10,5,1]]
    .map(([a,b,c,value],i) => returned(`clamp-${i}`,[a,b,c],value));
  count.push(...[[-1,5],[1.5,5],["10",5],[10,0],[0,0],[10,-1],[10,1.5],[10,"5"]]
    .map((args,i)=>rejected(`count-invalid-${i}`,args)));
  const invalidPage = [[1.2,10,5],["1",10,5],[1.2,0,5]].map((args,i)=>rejected(`page-invalid-${i}`,args));
  for(const [i,value] of [undefined,null,true,{},[],NaN,Infinity,-Infinity].entries()) {
    count.push(rejected(`items-invalid-${i}`,[value,5]),rejected(`size-invalid-${i}`,[10,value]));
    invalidPage.push(rejected(`page-other-invalid-${i}`,[value,10,5]));
  }
  return addPublicApiCoverage([["clampPage",[...count.map(item=>({...item,exportName:"pageCount"})),...clamp,...invalidPage]],["pageCount",count],["clampPage",[clamp[2]]],
    ["clampPage",clamp],["clampPage",invalidPage],["clampPage",invalidPage],["clampPage",[...count.map(item=>({...item,exportName:"pageCount"})),...clamp,...invalidPage]]].map(([exportName,cases],i)=>({
      route:"code", criterionId:criteria[i].criterionId, criterionHash:criteria[i].criterionHash,
      sourcePath:"src/frontend/pagination.js",exportName,maxAttempts:1,checks:[{id:`pagination-public-${i+1}`,cases}]
    })));
}
