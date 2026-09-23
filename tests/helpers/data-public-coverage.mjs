import assert from "node:assert/strict";
import { addPublicApiCoverage } from "./public-api-coverage.mjs";
import { data } from "./async-contract-cases.mjs";
const result=(id,input,value)=>({id,args:[data(input)],invocation:{kind:"call"},observeArgs:true,
  expected:{outcome:"return",value:data(value),argsAfter:[data(input)]}});
function csv(){
  const fields=[result("quoted-comma",'name,note\nAda,"one,two"',[["name","note"],["Ada","one,two"]]),
    result("escaped-quotes",'"He said ""yes""",tail',[[ 'He said "yes"',"tail"]]),result("single-quote",'""""',[['"']]),
    result("crlf-and-lf","a,b\r\nc,d\ne,f",[["a","b"],["c","d"],["e","f"]]),
    result("empty-fields",",middle,\n,,tail",[["","middle",""],["","","tail"]]),result("empty-quoted-final",'""',[[""]]),
    result("empty-quoted-after-record",'first\n""',[["first"],[""]]),result("empty-quoted-leading",'"",last',[["","last"]])];
  const lines=[result("quoted-newlines",'"first\nsecond","x\r\ny"\r\nlast,end',[["first\nsecond","x\r\ny"],["last","end"]])];
  const bad=['"unfinished','first,"unfinished\nnext','"escaped ""quote'].map((input,i)=>({id:`unterminated-${i}`,
    args:[data(input)],invocation:{kind:"call"},expected:{outcome:"throw",errorClass:"SyntaxError"}}));
  return {sourcePath:"src/data/csv.js",exportName:"parseCsv",count:6,groups:[[...fields,...lines,...bad],fields,lines,bad],
    anchors:["Replace the naive parser","Support comma-separated fields","Newlines inside quoted fields must be preserved.","Throw `SyntaxError` for an unterminated quoted field."]};
}
function dedup(){
  const firstA={id:"a",sequence:1,value:"old"},firstB={id:"b",sequence:3},newestA={id:"a",sequence:5,value:"new"},firstC={id:"c",sequence:2};
  const order=[result("first-appearance-order",[firstA,firstB,newestA,firstC],[newestA,firstB,firstC]),result("empty",[],[])];
  const greatest=[result("numeric-sequence",[{id:"a",sequence:-1},{id:"a",sequence:10},{id:"a",sequence:2}],[{id:"a",sequence:10}]),
    result("numeric-string-sequence",[{id:"b",sequence:"2"},{id:"b",sequence:"10"}],[{id:"b",sequence:"10"}])];
  const ties=[result("equal-later",[{id:"a",sequence:7,value:"first"},{id:"a",sequence:7,value:"later"}],[{id:"a",sequence:7,value:"later"}]),
    result("numeric-equal-later",[{id:"a",sequence:7,value:"first"},{id:"a",sequence:"7",value:"numeric tie"}],[{id:"a",sequence:"7",value:"numeric tie"}])];
  const names=[{id:"__proto__",sequence:2},{id:"constructor",sequence:1},{id:"toString",sequence:3}];
  const args=[{id:"b",sequence:2,value:{n:1}},{id:"a",sequence:1},{id:"b",sequence:3}];
  const mutation=result("input-identity-and-snapshot",args,[args[2],args[1]]);
  // Before/after values and retained output identity are independent checks.
  // Public project tests also retain each before-call input object identity.
  mutation.referencePairs=[{id:"retained-event",left:{root:"return",path:["0"]},right:{root:"argument",index:0,path:["2"]}}];
  mutation.expected.referenceIdentity=[{id:"retained-event",same:true}];
  const all=[...order,...greatest,...ties,result("prototype-names",names,names),mutation];
  return {sourcePath:"src/data/dedup.js",exportName:"deduplicateEvents",count:7,
    groups:[all,[...order,...greatest,...ties],[...order,...greatest],ties,all,all],
    anchors:["Fix `deduplicateEvents(events)`","Return one event per `id`.","The output order must follow the first appearance","If sequences tie, retain the later occurrence.","Do not mutate the input.","Keep the exported API and verify the project."]};
}
export function dataCoveredContracts(id,criteria){
  const family=(id==="quoted-csv"?csv:dedup)();assert.equal(criteria.length,family.count);
  family.anchors.forEach((text,i)=>assert.ok(criteria[i].criterionText.startsWith(text)));
  return addPublicApiCoverage(family.groups.map((cases,i)=>({route:"code",criterionId:criteria[i].criterionId,criterionHash:criteria[i].criterionHash,
    sourcePath:family.sourcePath,exportName:family.exportName,maxAttempts:1,checks:[{id:`data-public-${i+1}`,cases}]})));
}
