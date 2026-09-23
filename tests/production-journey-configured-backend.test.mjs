import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { loadProductionPublicWitnesses } from "./helpers/production-schedule-witnesses.mjs";
import { backendCoveredContracts } from "./helpers/backend-public-coverage.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { benchmarkVerificationReceiptForTurn } from "../scripts/benchmark-independent-verification.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { writeHostContractApproval, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
const repositoryRoot=path.resolve(import.meta.dirname,"..");
const imageId=process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID,dockerSocket=process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration={timeout:300000,skip:!imageId||!dockerSocket ? "requires pinned local worker; skip is not qualification" : false};
const scenarios=[
  {id:"billing-cutoff-clock-skew",mutate:source=>source.replace("event.receivedAt >= period.endsAt + period.maxClockSkewMs","event.receivedAt > period.endsAt + period.maxClockSkewMs"),
    smoke:"import {billingBucket} from '../src/backend/billing-window.js';test('smoke',()=>assert.equal(billingBucket({occurredAt:10,receivedAt:10},{startsAt:10,endsAt:20,maxClockSkewMs:2}),'current'));"},
  {id:"tenant-role-authorization",mutate:source=>source.replace(" && user.tenantId === resource.tenantId",""),
    smoke:"import {canManage} from '../src/backend/auth.js';test('smoke',()=>assert.equal(canManage({active:true,role:'owner',tenantId:'north'},{tenantId:'north'}),true));"},
  {id:"revoked-session-cache",mutate:source=>source.replace("return entry.tenantId === request.tenantId\n    && ","return "),
    smoke:"import {isCachedAccessUsable} from '../src/backend/revocation-cache.js';test('smoke',()=>assert.equal(isCachedAccessUsable({tenantId:'north',userId:'u',capability:'read',permissionRevision:1,evaluatedAt:0,expiresAt:10},{tenantId:'north',userId:'u',capability:'read',currentPermissionRevision:1,now:1,revokedAt:null}),true));"},
  {id:"invoice-rounding",mutate:source=>source.replace("line?.quantity ?? 1","line?.quantity ?? 2"),
    smoke:"import {invoiceTotalCents} from '../src/backend/invoice.js';test('smoke',()=>assert.equal(invoiceTotalCents([{unitCents:100,quantity:1}],0),100));"}
];
for(const scenario of scenarios)for(const variant of ["correct","wrong-with-green-checks","unsupported-import",...(scenario.id==="tenant-role-authorization"?["wrong-api-arity"]:[])]) {
  test(`configured backend ${scenario.id}: ${variant}`,integration,async t=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"piagent-configured-backend-")));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const prepared=await prepareProductionJourneyWorkspace(root,repositoryRoot,scenario.id);
    assert.deepEqual(prepared.turns.map(x=>x.id),["revoked-session-cache","billing-cutoff-clock-skew"].includes(scenario.id)?["request","recover"]:["request"]);
    const profile=resolveProjectProfileDocument(repositoryRoot,JSON.parse(fs.readFileSync(path.join(prepared.workspace,".pi/piagent-profile.json")))).profile;
    const preview=benchmarkVerificationReceiptForTurn(prepared.turns[0],{profile,policy:JSON.parse(fs.readFileSync(path.join(repositoryRoot,"packages/piagent-core/policies/base-policy.json")))});
    const contracts=backendCoveredContracts(scenario.id,preview.criteria),backend={imageId,dockerSocket,timeoutMs:10000,profile:expectedNodeProfile()};
    const approval=writeHostContractApproval({directory:path.join(root,"private-test-authority"),projectRoot:prepared.workspace,
      installedRoot:repositoryRoot,approved:true,operatorRequestDigest:operatorRequestDigest(preview.query),backend,contracts});
    const [sourcePath,reference]=productionV3ReferenceSolution(scenario.id);
    const source=variant==="wrong-api-arity"?reference.replace("canManage(user, resource)","canManage(user, resource, extra)"):variant==="wrong-with-green-checks"?scenario.mutate(reference):variant==="unsupported-import"?'import "node:fs";\n'+reference:reference;
    if(variant!=="correct")assert.notEqual(source,reference);
    const publicTests=variant==="wrong-with-green-checks" ? "import assert from 'node:assert/strict';import test from 'node:test';"+scenario.smoke+"\n"
      :loadProductionPublicWitnesses(repositoryRoot).get(scenario.id).tests;
    const commands=selectVerificationPlan(profile,undefined,"source-change",prepared.workspace,[sourcePath,"test/**"]).commands;
    await withJourneyEnvironment({...prepared.environment,PIAGENT_INDEPENDENT_VERIFICATION_CONFIG:approval.configPath},async()=>{
      const runtime=await scriptedProductionSupervisor({root,cwd:prepared.workspace,agentDir:prepared.agentDir,repositoryRoot,transport:"loopback"});
      try {
        const first=await runtime.turn(prepared.turns[0],[scriptedTool("backend-read","read",{path:sourcePath}),
          scriptedTool("backend-write","write",{path:sourcePath,content:source}),
          scriptedTool("backend-tests","write",{path:"test/configured-backend-public.test.js",content:publicTests}),
          ...commands.map((command,i)=>scriptedTool(`backend-verify-${i}`,"bash",{command})),
          scriptedText("Implemented the requested backend behavior, preserved the exported API and ran project verification. The requested work is complete.")],180000);
        let final=first;
        if(prepared.turns.length===2) {
          const replay=first.task.trace.outcome==="completed";
          final=await runtime.turn(prepared.turns[1],replay?[]:[scriptedTool("backend-recover-read","read",{path:sourcePath}),
            ...commands.map((command,i)=>scriptedTool(`backend-recover-verify-${i}`,"bash",{command})),
            scriptedText("Rechecked the original backend obligations and current project verification. The requested work is complete.")],180000);
          assert.equal(final.task.taskRunId,first.task.taskRunId);assert.equal(final.sessionId,first.sessionId);
          if(variant==="correct") {assert.equal(final.scriptedTurns,0);assert.equal(final.task.trace.outcome,"completed");assert.deepEqual(final.task.verifyEvidence,first.task.verifyEvidence);}
          assert.equal(runtime.transport.snapshot().reconnects,1);
        }
        assert.deepEqual(runtime.extensionErrors,[]);assert.deepEqual(runtime.serviceErrors,[]);assert.equal(runtime.metrics.realProviderCalls,0);
        assert.equal(first.task.operatorRequestDigest,operatorRequestDigest(preview.query));
        const checks=runtime.rawEvents.filter(e=>e.type==="tool_execution_end"&&/^backend-(?:recover-)?verify-/.test(e.toolCallId));
        assert.equal(checks.length,commands.length*(prepared.turns.length===2&&variant!=="correct"?2:1));
        assert.ok(checks.every(e=>e.isError===false),"all actual project commands must pass even for the wrong variant");
        const config=openHostContractConfiguration({configPath:approval.configPath,projectRoot:prepared.workspace,installedRoot:repositoryRoot});
        try {
          assert.equal(config.isCurrent(),true);
          const receipts=contracts.map(contract=>{
            const event=config.store.latest({taskRunId:first.task.taskRunId,criterionId:contract.criterionId});
            assert.equal(event?.phase,"settled");assert.equal(event.binding.criterionHash,contract.criterionHash);
            const evidence=JSON.parse(event.evidenceText),execution=evidence.observed.result.execution;
            const compiled=compileIndependentContract(JSON.stringify({schemaVersion:2,profile:backend.profile,source,exportName:contract.exportName,checks:contract.checks}));
            assert.equal(compiled.planDigest,event.binding.planDigest);assert.equal(execution.cleanupConfirmed,true);
            const compared=compareIndependentExecution(compiled,execution);assert.equal(compared.verdict,evidence.verdict);
            return {criterion:contract.criterionId,cases:contract.checks.reduce((n,c)=>n+c.cases.length,0),verdict:compared.verdict,counterexamples:compared.counterexamples.map(x=>x.evidence.input.id)};
          });
          t.diagnostic(JSON.stringify({scenario:scenario.id,variant,treatment:"configured-host-verification-a-v2",outcomes:[first.task.trace.outcome,final.task.trace.outcome],
            modelMessages:[first.scriptedTurns,final.scriptedTurns],criteria:final.task.acceptanceReceipt.criteria.map(x=>[x.id,x.status]),receipts,imageId,profile:backend.profile,
            verifierDigest:approval.verifierDigest,productionAuthority:false}));
          if(variant==="correct") {assert.ok(receipts.every(x=>x.verdict==="pass"));assert.equal(first.task.trace.outcome,"completed");}
          else {
            assert.notEqual(first.task.trace.outcome,"completed");assert.notEqual(final.task.trace.outcome,"completed");
            const handoff=JSON.parse(fs.readFileSync(path.join(prepared.workspace,".pi/piagent-state/handoffs",`${final.task.taskRunId}.json`)));
            assert.equal(handoff.state.completionApproved,false);assert.equal(handoff.nextSafeAction.action,"handoff");
            if(variant==="unsupported-import")assert.ok(receipts.every(x=>x.verdict!=="pass"));else assert.ok(receipts.some(x=>x.verdict==="fail"));
          }
        } finally {config.close();}
      } finally {await runtime.close();}
    });
  });
}
