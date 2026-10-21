// Evidence-only lessons from main-agent checks. No model call, raw tool log,
// or guessed root cause. A passing rerun needs an intervening edit/runner
// change; otherwise a flaky check would become a supposed fix. A command
// that failed the same way twice in a round is a lesson too (after Cognee's
// live failure lessons): its first error line, sanitized, without a cause.
import os from 'node:os';
import { createHash } from 'node:crypto';
import { redactedText } from '../runtime/managed-failure.mjs';
import { isCheckCommand } from './workflow.mjs';

const COMMAND_TOOLS = new Set(['bash','run_with_network','run_with_docker','run_on_host']);
const textOf = result => (result?.content ?? []).filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n');
const clean = (value, max) => redactedText(String(value ?? '')).replace(/\bas_(?:live|run)_[A-Za-z0-9_-]{8,}/g,'[REDACTED_SECRET]').split(os.homedir()).join('~').replace(/\s+/g,' ').trim().slice(0,max);
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,20);
// A check's output may be merged (2>&1) and cut to its tail (| tail -n 80):
// agents do that to keep long test logs short. The pipeline's exit status is
// then tail's, so such a check is judged by its output alone.
const OUTPUT_TAIL = /\s*(?:2>&1\s*)?(?:\|\s*(?:tail(?:\s+(?:-n\s*\d+|-\d+|--lines=\d+))?|cat))?\s*$/;
function check(command, declared) {
 const raw=String(command ?? '').trim();
 // Simple check commands only. Permit one explicit working-directory prefix
 // and a merged, tail-cut output; no other pipelines, redirected results,
 // fallback exits or shell substitution.
 let body=raw.replace(/^cd\s+(?:"[\w ./-]+"|'[\w ./-]+'|[\w./-]+)\s*&&\s*/, '');
 const prefix=raw.slice(0,raw.length-body.length), tail=OUTPUT_TAIL.exec(body), piped=!!tail?.[0].includes('|');
 if (tail?.[0]) body=body.slice(0,tail.index);
 if (/[\n\r;|&<>`$]/.test(body) || /(?:skip|only|grep|testNamePattern|testPathPattern|--filter|--list|dry.run|--passWithNoTests|--watch|--collect-only|--exclude|-Dtest=)/i.test(body)) return null;
 if (!isCheckCommand(body,declared) && !/^(?:\.\/)?mvnw?\s+(?:[^;&]*\s)?(?:test|verify)\b/.test(body)) return null;
 // The same check with and without a tail is one check (a rerun, not a new command).
 const scope=prefix+body;
 return { command: clean(raw,220), key: hash(scope), family: hash(scope.replace(/(?:^|\s)-P[\w,.-]+/g,'')), piped };
}
// Failure markers in a piped check's output (its exit status is tail's).
const failedOutput = output => /\b(?:FAIL(?:ED|URES?)?|ERRORS?|BUILD FAILURE|Tests? failed|[1-9]\d*\s+(?:failed|failing|failures?|errors?))\b|npm ERR!/.test(output.replace(/\b(?:fail(?:ed|ures?)?|errors?|skipped)\s*[:=]?\s*0\b|\b0\s+(?:failed|failures?|errors?|skipped)\b/gi,''));
function total(output) { const m=/(?:Tests run:\s*|\btests\s+)(\d+)/i.exec(output);return m?Number(m[1]):null; }
function passed(output) {
 const withoutZeros=output.replace(/\b(?:fail(?:ed|ures?)?|errors?|skipped)\s*[:=]?\s*0\b|\b0\s+(?:failed|failures?|errors?|skipped)\b/gi,'');
 if(/\b(?:FAIL(?:ED|URES?)?|ERRORS?|SKIPPED)\b/i.test(withoutZeros)) return false;
 if (/\b(?:[1-9]\d*\s+(?:skipped|failed)|(?:skip|skipped|fail|failed)\s*[:=]?\s*[1-9]\d*|no tests|tests? (?:were )?not (?:run|found)|collected 0|aborted|cancelled|timed out)\b/i.test(output)) return false;
 return /(?:\bPASS\b|\b[1-9]\d* (?:passed|passing)\b|\bTests run:\s*[1-9]\d*,\s*Failures:\s*0,\s*Errors:\s*0|\bpass\s+[1-9]\d*|BUILD SUCCESS|Build succeeded|\bok\s+\S+)/i.test(output);
}

// What an error says, without what varies between runs: numbers, ids,
// temporary paths and quoted values.
export const errorShape = text => clean(text,180).replace(/\/(?:tmp|var\/folders|private)\/\S*/g,'<tmp>').replace(/\b[0-9a-f]{8,}\b/gi,'<id>').replace(/\d+/g,'N').replace(/(["'`])[^"'`]{1,80}\1/g,'$1…$1');
const ERROR_LINE = /error|fail|exception|not found|no such|denied|refused|cannot|unknown (?:option|flag|command)|invalid|EADDRINUSE|ENOENT|EACCES/i;
const MAX_LESSONS = 3;

export class CheckLessons {
 constructor(declared = [], now = Date.now) { this.declared=declared;this.now=now;this.calls=new Map();this.failures=new Map();this.errors=new Map();this.edits=[];this.lessons=[];this.failed=0;this.passed=0;this.last='none'; }
 // A non-check command that failed: the second time with the same error
 // shape it becomes a failure lesson for the team memory.
 #toolError(call,event,output) {
  if(!COMMAND_TOOLS.has(call.tool)||call.check||this.lessons.length>=MAX_LESSONS)return;
  if(/managed[-_](?:tool[-_]cancelled|operation[-_]denied|helper[-_]cancelled)|Command aborted|Command timed out/i.test(output))return;
  const line=output.split('\n').find(l=>ERROR_LINE.test(l));
  if(!line)return;
  const command=clean(call.command,160).split(' ')[0];
  if(!command)return;
  const shape=errorShape(line), key=hash(command+'\0'+shape), seen=this.errors.get(key);
  if(!seen){if(this.errors.size>=40)this.errors.delete(this.errors.keys().next().value);this.errors.set(key,{id:event.toolCallId,command:clean(call.command,160),error:clean(line,180),done:false});return;}
  if(seen.done)return;
  seen.done=true;
  this.lessons.push({kind:'tool_error',line:clean(`Observed repeated tool error: ${seen.command} failed twice in one round with "${seen.error}". Cause not established; check the command, its flags and the environment before running it again.`,900),
   fingerprint:hash('tool\0'+command+'\0'+shape),failed_call:seen.id,passed_call:event.toolCallId,at:new Date(this.now()).toISOString()});
 }
 // How the round's checks ended, for memory: passed, failed or none.
 get summary() { return { passed:this.passed, failed:this.failed, final:this.last }; }
 event(event) {
  if(event?.type==='tool_execution_start') {
   if(this.calls.size>=32)this.calls.delete(this.calls.keys().next().value);
   this.calls.set(event.toolCallId,{tool:event.toolName,check:COMMAND_TOOLS.has(event.toolName)?check(event.args?.command,this.declared):null,path:clean(event.args?.path,120),command:COMMAND_TOOLS.has(event.toolName)?String(event.args?.command??''):''});return;
  }
  if(event?.type!=='tool_execution_end')return;
  const call=this.calls.get(event.toolCallId);this.calls.delete(event.toolCallId);if(!call)return;
  if(['write','edit'].includes(call.tool)&&!event.isError){this.edits.push(call.path);if(this.edits.length>100)this.edits.shift();return;}
  if(!call.check){
   const failed=event.isError || (event.result?.details?.exitCode !== undefined && event.result.details.exitCode!==0);
   if(failed)this.#toolError(call,event,textOf(event.result));
   return;
  }
  const output=textOf(event.result), c=call.check;
  const exitFailed=event.isError || (event.result?.details?.exitCode !== undefined && event.result.details.exitCode!==0);
  if(exitFailed || (c.piped && failedOutput(output))) {
   if(/managed[-_](?:tool[-_]cancelled|operation[-_]denied|helper[-_]cancelled)|Command aborted|Command timed out/i.test(output))return;
   this.failed++;this.last='failed';
   const diagnostic=output.split('\n').find(l=>/error|fail|exception|not found|EADDRINUSE/i.test(l)) ?? 'Check exited unsuccessfully';
   if(this.failures.size>=20)this.failures.delete(this.failures.keys().next().value);
   this.failures.set(c.key,{...c,tool:call.tool,id:event.toolCallId,error:clean(diagnostic,180),edits:this.edits.length,total:total(output)});return;
  }
  if(!passed(output))return;
  this.passed++;this.last='passed';
  let prior=this.failures.get(c.key);
  // A Maven profile change may alter coverage: accept it only when both
  // executions explicitly report the same positive test count.
  if(!prior)prior=[...this.failures.values()].find(f=>f.family===c.family&&f.total>0&&f.total===total(output));
  if(!prior || this.lessons.length>=MAX_LESSONS || (prior.total>0 && total(output)!==null && total(output)<prior.total))return;
  const files=this.edits.slice(prior.edits), changedRunner=prior.tool!==call.tool, changedCommand=prior.key!==c.key;
  if(!files.length&&!changedRunner&&!changedCommand)return;
  const fixed=files.length?`edited ${[...new Set(files)].slice(0,3).join(', ')}`:changedRunner?`changed runner from ${prior.tool} to ${call.tool}`:'changed the command profile (same reported test count)';
  const line=clean(`Observed check recovery: ${prior.command} failed (${prior.error}); after ${fixed}, ${c.command} passed via ${call.tool}. Root cause not established; verify against current code.`,900);
  this.lessons.push({kind:'check_recovery',line,fingerprint:hash(prior.command+'\0'+prior.error),failed_call:prior.id,passed_call:event.toolCallId,at:new Date(this.now()).toISOString()});
  this.failures.delete(prior.key);
 }
}
