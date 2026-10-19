import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckLessons } from '../packages/piagent-core/managed/memory-lessons.mjs';
import { turnRecord } from '../packages/piagent-core/managed/memory.mjs';
let seq=0;
function run(c,command,output,isError=false,tool='bash') {const id=`call_${++seq}`;c.event({type:'tool_execution_start',toolName:tool,toolCallId:id,args:{command}});c.event({type:'tool_execution_end',toolName:tool,toolCallId:id,isError,result:{content:[{type:'text',text:output}]}});}
function edit(c,p='src/invoice.ts') {const id=`edit_${++seq}`;c.event({type:'tool_execution_start',toolName:'edit',toolCallId:id,args:{path:p}});c.event({type:'tool_execution_end',toolCallId:id,isError:false});}
test('failure plus edit plus equivalent passing check yields a bounded sourced lesson, without guessing cause',()=>{
 const c=new CheckLessons();run(c,'npm test','FAIL money rounding',true);edit(c);run(c,'npm test','3 passed');
 assert.equal(c.lessons.length,1);assert.match(c.lessons[0].line,/invoice.ts/);assert.match(c.lessons[0].line,/Root cause not established/);
 assert.ok(c.lessons[0].failed_call);assert.ok(c.lessons[0].passed_call);
});
test('flaky reruns, unrelated modules, narrowed checks and skipped tests are not verified fixes',()=>{
 const c=new CheckLessons();run(c,'npm test','FAIL',true);run(c,'npm test','3 passed');assert.equal(c.lessons.length,0);
 edit(c);run(c,'cd other && npm test','3 passed');run(c,'npm test --filter one','1 passed');run(c,'npm test || true','3 passed');run(c,'npm test','3 passed, 1 skipped');assert.equal(c.lessons.length,0);
 run(c,'npm test','3 passed');assert.equal(c.lessons.length,1);
});
test('cancelled tools, empty success and echoed test output cannot create lessons',()=>{
 const c=new CheckLessons();run(c,'npm test','managed-operation-denied',true);assert.equal(c.failed,0);run(c,'npm test','Command aborted',true);edit(c);run(c,'npm test','3 passed');
 run(c,'echo npm test','FAIL',true);edit(c);run(c,'echo npm test','3 passed');assert.equal(c.lessons.length,0);
 run(c,'npm test','FAIL',true);edit(c);run(c,'npm test','');assert.equal(c.lessons.length,0);
});
test('profile changes require equal positive test counts; runner changes keep the actual scope',()=>{
 const c=new CheckLessons();run(c,'./mvnw test','Tests run: 4, Failures: 1, Errors: 0',true);
 run(c,'./mvnw -Pdev test','Tests run: 2, Failures: 0, Errors: 0');assert.equal(c.lessons.length,0);
 run(c,'./mvnw -Pdev test','Tests run: 4, Failures: 0, Errors: 0');assert.equal(c.lessons.length,1);
 run(c,'npm test','Error network unavailable',true);run(c,'npm test','3 passed',false,'run_with_network');
 assert.match(c.lessons[1].line,/changed runner from bash to run_with_network/);
});
test('secrets are removed and long member messages cannot crowd out the answer and lessons',()=>{
 const c=new CheckLessons();run(c,'npm test','FAIL token as_run_abcdefghijklmnopqrstuv sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX',true);edit(c);run(c,'npm test','3 passed');
 const record=turnRecord([{role:'user',content:'large '.repeat(20000)},{role:'assistant',content:'Final checked answer'}],[],c.lessons);
 assert.ok(Buffer.byteLength(record)<=30*1024);assert.match(record,/Final checked answer/);assert.match(record,/Observed check recovery/);
 assert.doesNotMatch(record,/abcdefghijklmnopqrstuv|ABCDEFGHIJKLMNOPQRSTUVWX/);
});

test('mixed success and failure output, or fewer reported tests, cannot establish recovery',()=>{
 const c=new CheckLessons();run(c,'npm test','Tests run: 4, Failures: 1',true);edit(c);
 run(c,'npm test','PASS one suite\nFAIL another');run(c,'npm test','Tests run: 2, Failures: 0, Errors: 0');
 assert.equal(c.lessons.length,0);
});

test('secret redaction precedes byte clipping, including long multiline keys',()=>{
 const key='-----BEGIN PRIVATE KEY-----\n'+'SYNTHETIC_PRIVATE_MATERIAL'.repeat(2000)+'\n-----END PRIVATE KEY-----';
 const record=turnRecord([{role:'user',content:key},{role:'assistant',content:'Checked answer'}]);
 assert.doesNotMatch(record,/SYNTHETIC_PRIVATE_MATERIAL|BEGIN PRIVATE KEY/);assert.match(record,/Checked answer/);
});

test('a check cut to its tail counts, judged by its output, as the same check as without the tail',()=>{
 const c=new CheckLessons();run(c,'npm test 2>&1 | tail -n 40','FAIL money rounding\n1 failed');
 assert.equal(c.failed,1,'a piped failure exits 0 (tail) yet counts as failed');assert.equal(c.summary.final,'failed');
 edit(c);run(c,'npm test | tail -20','Tests: 3 passed');
 assert.equal(c.lessons.length,1);assert.match(c.lessons[0].line,/npm test 2>&1 \| tail -n 40 failed .*npm test \| tail -20 passed/);
 assert.deepEqual(c.summary,{passed:1,failed:1,final:'passed'});
 // Only tail/cat: grep or head can hide the failure; other pipelines stay out.
 run(c,'npm test | grep PASS','3 passed');run(c,'npm test | head -5','3 passed');run(c,'npm test | tail -5 | sort','3 passed');
 assert.equal(c.passed,1);
 // A tail of passing output with zero failures is a pass.
 const d=new CheckLessons();run(d,'./mvnw test 2>&1 | tail -n 30','Tests run: 4, Failures: 0, Errors: 0\nBUILD SUCCESS');
 assert.deepEqual(d.summary,{passed:1,failed:0,final:'passed'});
 assert.deepEqual(new CheckLessons().summary,{passed:0,failed:0,final:'none'});
 // A flaky rerun with another tail length is no recovery.
 const e=new CheckLessons();run(e,'npm test 2>&1 | tail -40','1 failed');run(e,'npm test 2>&1 | tail -80','3 passed');assert.equal(e.lessons.length,0);
});
