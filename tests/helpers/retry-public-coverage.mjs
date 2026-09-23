import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import assert from "node:assert/strict";
import { data, record } from "./async-contract-cases.mjs";
import { retryCases } from "./async-production-cases.mjs";
// Reviewed public bounded-retry witnesses; no registered recipe or oracle.
function retry(){
  const cases=retryCases().map(item=>({...item,invocation:{kind:"call"}}));
  const first=cases[0],bad=cases.find(item=>item.id==="invalid-attempts-0");
  const huge=structuredClone(first);huge.id="large-integer-attempt-limit";
  huge.args[1].value.find(item=>item.key==="maxAttempts").value=data(2**54);huge.expected.argsAfter=huge.args;cases.push(huge);
  const infinity=structuredClone(bad);infinity.id="infinite-attempt-limit";
  infinity.args[1].value.find(item=>item.key==="maxAttempts").value=data(Infinity);infinity.expected.argsAfter=infinity.args;cases.push(infinity);
  for(const [i,value] of [false,0,{},"sleep"].entries()) {
    const item=structuredClone(bad);item.id=`invalid-sleep-${i}`;
    item.args[1]=record({maxAttempts:data(2),baseDelayMs:data(1),sleep:data(value)});item.expected.argsAfter=item.args;cases.push(item);
  }
  // The existing callback trace explicitly observes awaited settlement and
  // original error identity; unsupported default timer behavior is not claimed.
  const valid=cases.filter(item=>item.expected.outcome==="return"),failed=cases.filter(item=>item.id==="final-error-no-sleep"),
    invalid=cases.filter(item=>item.expected.errorClass==="TypeError");
  return {sourcePath:"src/reliability/retry.js",exportName:"retry",count:7,groups:[cases,[...valid,...failed,...invalid],[...valid,...failed],cases.slice(1,3),failed,cases],
    anchors:["Correct `retry(operation, options)`","Call the operation at most","Return on success and rethrow","Between failures only, await","Never sleep after the final failure.","Validate invalid options with `TypeError`, preserve the API, and verify the project."]};
}
export function retryCoveredContracts(_id,criteria) {
  const family=retry();assert.equal(criteria.length,family.count);
  family.anchors.forEach((text,i)=>assert.ok(criteria[i].criterionText.startsWith(text)));
  return addPublicApiCoverage(family.groups.map((cases,i)=>({route:"code",criterionId:criteria[i].criterionId,criterionHash:criteria[i].criterionHash,
    sourcePath:family.sourcePath,exportName:family.exportName,maxAttempts:1,checks:[{id:`retry-public-${i+1}`,cases}]})));
}
