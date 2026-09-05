import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as runtime from "../scripts/benchmark-budget-runtime.mjs";
import { startBenchmarkBudgetLaunch } from "../scripts/benchmark-budget-launcher.mjs";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";

const execution = { model:"openai-codex/gpt-5.6-luna",thinking:"medium",serviceTier:"fast",
  surfaces:["piagent","codex-cli"],repeats:2,timeoutSeconds:900,infrastructureRetries:0,
  codexMode:"controlled",codexBaseline:"stock",piagentTreatment:"release-defaults" };
const usage = {sessions:1,usageCompleteness:"exact",input:10,output:4,cacheRead:0,cacheWrite:0,reasoning:1,fresh:14,total:14};
function fixture(t, maximum=2) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"pi-budget-runtime-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,"run"),policyFile=path.join(root,"policy.json"),state=path.join(root,"state.json");
  const policy={schemaVersion:1,kind:"benchmark-management-budget-v1",authorityDecision:"test-only",
    policy:{semantics:"management-thresholds",maxProviderAttempts:maximum,freshTokenThreshold:100,activeWallTimeMsThreshold:1000},
    binding:{runRoot:output,candidateDigest:"a".repeat(64),suiteDigest:"b".repeat(64),execution,
      plannedAttempts:Array.from({length:maximum},(_,i)=>({orderIndex:i+1,scenarioId:"case",surface:i%2?"codex-cli":"piagent",repeat:1}))}};
  const write=()=>fs.writeFileSync(policyFile,JSON.stringify(policy));
  write();
  const options={...execution,output,budgetPolicy:policyFile,budgetState:state};
  const control=runtime.readBenchmarkBudgetControl({options});
  return {root,output,policyFile,state,policy,options,control,write};
}
const attempt=(f,index=0)=>({...f.policy.binding.plannedAttempts[index],attemptId:"id-"+index,infrastructureAttempt:1});

test("budget CLI requires paired unique policy/state arguments",()=>{
  assert.throws(()=>parseBenchmarkArgs(["--budget-policy","/p"]),/supplied together/);
  assert.throws(()=>parseBenchmarkArgs(["--budget-policy","/p","--budget-policy","/p","--budget-state","/s"]),/once/);
  const value=parseBenchmarkArgs(["--budget-policy","/p","--budget-state","/s"]);
  assert.equal(value.budgetPolicy,"/p");assert.equal(value.budgetState,"/s");
});
test("budget initial launch requires pinned output",t=>{
  const f=fixture(t);delete f.options.output;
  assert.throws(()=>runtime.readBenchmarkBudgetControl({options:f.options}),/output/);
});
test("state cannot enter model run root through a parent symlink",t=>{
  const f=fixture(t);fs.mkdirSync(f.output);
  fs.symlinkSync(f.output,path.join(f.root,"alias"),"dir");
  f.options.budgetState=path.join(f.root,"alias","state.json");
  assert.throws(()=>runtime.readBenchmarkBudgetControl({options:f.options}),/canonical|workspace|alias/);
});
test("budget state must stay outside candidate source",t=>{
  const f=fixture(t),source=path.join(f.root,"source");fs.mkdirSync(source);
  f.options.budgetState=path.join(source,"state.json");
  assert.throws(()=>runtime.readBenchmarkBudgetControl({options:f.options,sourceRoot:source}),/source/);
});
test("resume restores same policy identity but forbids policy reset/addition",t=>{
  const f=fixture(t),manifest={budgetControl:f.control.identity};
  const restored=runtime.readBenchmarkBudgetControl({options:{resume:f.output},resumeManifest:manifest});
  assert.deepEqual(restored.identity,f.control.identity);
  assert.throws(()=>runtime.readBenchmarkBudgetControl({options:f.options,resumeManifest:{}}),/cannot add/);
  f.policy.policy.freshTokenThreshold=200;f.write();
  assert.throws(()=>runtime.readBenchmarkBudgetControl({options:f.options,resumeManifest:manifest}),/identity changed/);
});
test("frozen policy rejects source, workload and model drift",t=>{
  const f=fixture(t),bound={options:f.options,candidateDigest:"a".repeat(64),suiteDigest:"b".repeat(64),fullOrder:f.policy.binding.plannedAttempts};
  assert.doesNotThrow(()=>runtime.assertBenchmarkBudgetBinding(f.control,bound));
  assert.throws(()=>runtime.assertBenchmarkBudgetBinding(f.control,{...bound,candidateDigest:"c".repeat(64)}),/source or suite/);
  assert.throws(()=>runtime.assertBenchmarkBudgetBinding(f.control,{...bound,options:{...f.options,thinking:"high"}}),/configuration/);
  assert.throws(()=>runtime.assertBenchmarkBudgetBinding(f.control,{...bound,fullOrder:[...bound.fullOrder].reverse()}),/order/);
});
test("exact spend settles both ledgers even if campaign bookkeeping fails",()=>{
  const seen=[];
  const callbacks=runtime.createBudgetProviderCallbacks({providerStarted:()=>seen.push("budget-start"),providerReturned:()=>seen.push("budget-return")},
    {providerStarted:()=>seen.push("campaign-start"),providerReturned:()=>{seen.push("campaign-return");throw new Error("campaign-write");}});
  callbacks.onProviderAttemptStart({});
  assert.throws(()=>callbacks.onProviderAttemptReturned({}),/campaign-write/);
  assert.deepEqual(seen,["budget-start","campaign-start","campaign-return","budget-return"]);
});
test("watchdog deadline does not refund time used for durable stage writes",t=>{
  const f=fixture(t),delays=[];let calls=0;
  const launch=startBenchmarkBudgetLaunch(f.control,{now:()=>++calls<=2?100:150,schedule:(_fn,ms)=>{delays.push(ms);return 1;},cancel:()=>{}});
  launch.supervise({kill:()=>{}});
  assert.equal(delays[0],950);
  launch.finish();
});
test("one-use parent/core/finalizer handoff retains exact final-cap attempt",t=>{
  const f=fixture(t,1);let clock=100;
  const launch=startBenchmarkBudgetLaunch(f.control,{now:()=>clock});
  const core=runtime.openBenchmarkBudgetCore(f.control,{env:{[runtime.BENCHMARK_BUDGET_CONTEXT]:launch.context},parentPid:process.pid,now:()=>clock});
  core.check();core.providerStarted(attempt(f));
  assert.doesNotThrow(()=>core.check(),"last admitted attempt may finish its remaining turns");
  core.providerReturned({...attempt(f),usage,usageStatus:"measured"});
  assert.throws(()=>core.check(),/session-cap/);
  core.close();clock=200;
  const result=launch.finish();
  assert.equal(result.providerStartedAttempts,1);assert.equal(result.knownExactFreshTokens,14);
  assert.equal(result.activeWallTimeMs,100);assert.equal(result.unknownAttempts,0);
});
test("missing and foreign launcher context deny core dispatch",t=>{
  const f=fixture(t);
  assert.throws(()=>runtime.openBenchmarkBudgetCore(f.control,{env:{}}),/handoff/);
  assert.throws(()=>runtime.openBenchmarkBudgetCore(null,{env:{[runtime.BENCHMARK_BUDGET_CONTEXT]:"{}"}}),/no bound policy/);
});

test("policy drift during the last attempt retains exact spend and stops",t=>{
  const f=fixture(t,1);let clock=100;
  const launch=startBenchmarkBudgetLaunch(f.control,{now:()=>clock});
  const core=runtime.openBenchmarkBudgetCore(f.control,{env:{[runtime.BENCHMARK_BUDGET_CONTEXT]:launch.context},parentPid:process.pid,now:()=>clock});
  core.providerStarted(attempt(f));
  f.policy.policy.freshTokenThreshold=200;f.write();
  assert.throws(()=>core.providerReturned({...attempt(f),usage,usageStatus:"measured"}),/policy changed/);
  assert.equal(core.governor.snapshot().knownExactFreshTokens,14);
  assert.ok(core.governor.snapshot().stopReasons.includes("budget-policy-changed"));
  core.close();clock=200;
  const final=launch.finish();
  assert.equal(final.unknownAttempts,0);
  assert.equal(final.knownExactFreshTokens,14);
  assert.ok(final.stopReasons.includes("budget-policy-changed"));
});
