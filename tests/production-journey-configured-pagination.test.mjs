import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { loadProductionPublicWitnesses } from "./helpers/production-schedule-witnesses.mjs";
import { paginationCoveredContracts } from "./helpers/pagination-public-coverage.mjs";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { benchmarkVerificationReceiptForTurn } from "../scripts/benchmark-independent-verification.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { writeHostContractApproval, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { compileIndependentContract, compareIndependentExecution } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
const repositoryRoot = path.resolve(import.meta.dirname,"..");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { timeout:180000,skip:!imageId||!dockerSocket ? "requires pinned local worker; skip is not qualification" : false };
for(const variant of ["correct","rounds-page","safe-integer-only","unsupported-import"]) {
  test(`configured pagination preserves approved Number semantics and API: ${variant}`,integration,async t=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"piagent-configured-pagination-")));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const prepared=await prepareProductionJourneyWorkspace(root,repositoryRoot,"pagination-boundary");
    assert.equal(prepared.scenario.profile,"web-frontend");assert.deepEqual(prepared.turns.map(x=>x.id),["request"]);
    const profile=resolveProjectProfileDocument(repositoryRoot,JSON.parse(fs.readFileSync(path.join(prepared.workspace,".pi/piagent-profile.json")))).profile;
    const preview=benchmarkVerificationReceiptForTurn(prepared.turns[0],{profile,policy:JSON.parse(fs.readFileSync(path.join(repositoryRoot,"packages/piagent-core/policies/base-policy.json")))});
    const contracts=paginationCoveredContracts(preview.criteria),backend={imageId,dockerSocket,timeoutMs:10000,profile:expectedNodeProfile()};
    const approval=writeHostContractApproval({directory:path.join(root,"private-test-authority"),projectRoot:prepared.workspace,
      installedRoot:repositoryRoot,approved:true,operatorRequestDigest:operatorRequestDigest(preview.query),backend,contracts});
    const [sourcePath,reference]=productionV3ReferenceSolution(prepared.scenario.id);
    const source=variant==="rounds-page" ? reference.replace('if (!Number.isInteger(page)) throw new TypeError("invalid page");','page = Math.round(page);')
      : variant==="safe-integer-only" ? reference.replace('Number.isInteger(value)','Number.isSafeInteger(value)')
      : variant==="unsupported-import" ? 'import "node:fs";\n'+reference : reference;
    if(variant!=="correct")assert.notEqual(source,reference);
    const publicTests=["rounds-page","safe-integer-only"].includes(variant)
      ? "import assert from 'node:assert/strict';import test from 'node:test';import {pageCount,clampPage} from '../src/frontend/pagination.js';test('public smoke',()=>{assert.equal(pageCount(0,5),0);assert.equal(clampPage(1,10,5),1);});\n"
      : loadProductionPublicWitnesses(repositoryRoot).get(prepared.scenario.id).tests;
    const commands=selectVerificationPlan(profile,undefined,"source-change",prepared.workspace,[sourcePath,"test/**"]).commands;
    await withJourneyEnvironment({...prepared.environment,PIAGENT_INDEPENDENT_VERIFICATION_CONFIG:approval.configPath},async()=>{
      const runtime=await scriptedProductionSupervisor({root,cwd:prepared.workspace,agentDir:prepared.agentDir,repositoryRoot,transport:"loopback"});
      try {
        const observed=await runtime.turn(prepared.turns[0],[scriptedTool("pagination-read","read",{path:sourcePath}),
          scriptedTool("pagination-write","write",{path:sourcePath,content:source}),
          scriptedTool("pagination-tests","write",{path:"test/configured-pagination-public.test.js",content:publicTests}),
          ...commands.map((command,i)=>scriptedTool(`pagination-verify-${i}`,"bash",{command})),
          scriptedText("Implemented pagination while preserving the API and ran project verification. The requested work is complete.")], 120000);
        assert.deepEqual(runtime.extensionErrors,[]);assert.deepEqual(runtime.serviceErrors,[]);assert.equal(runtime.metrics.realProviderCalls,0);
        assert.equal(observed.task.operatorRequestDigest,operatorRequestDigest(preview.query));
        const checks=runtime.rawEvents.filter(e=>e.type==="tool_execution_end"&&e.toolCallId.startsWith("pagination-verify-"));
        assert.equal(checks.length,commands.length);assert.ok(checks.every(e=>e.isError===false));
        const config=openHostContractConfiguration({configPath:approval.configPath,projectRoot:prepared.workspace,installedRoot:repositoryRoot});
        try {
          assert.equal(config.isCurrent(),true);
          const receipts=contracts.map(contract=>{
            const event=config.store.latest({taskRunId:observed.task.taskRunId,criterionId:contract.criterionId});
            assert.equal(event?.phase,"settled");assert.equal(event.binding.criterionHash,contract.criterionHash);
            const evidence=JSON.parse(event.evidenceText),execution=evidence.observed.result.execution;
            const compiled=compileIndependentContract(JSON.stringify({schemaVersion:2,profile:backend.profile,source,exportName:contract.exportName,checks:contract.checks}));
            assert.equal(compiled.planDigest,event.binding.planDigest);assert.equal(execution.cleanupConfirmed,true);
            const compared=compareIndependentExecution(compiled,execution);assert.equal(compared.verdict,evidence.verdict);
            return {criterion:contract.criterionId,verdict:compared.verdict,counterexamples:compared.counterexamples.map(x=>x.evidence.input.id)};
          });
          t.diagnostic(JSON.stringify({variant,treatment:"configured-host-verification-a-v2",outcome:observed.task.trace.outcome,
            criteria:observed.task.acceptanceReceipt.criteria.map(x=>[x.id,x.status]),receipts,imageId,profile:backend.profile,
            verifierDigest:approval.verifierDigest,productionAuthority:false}));
          if(variant==="correct") {
            assert.ok(receipts.every(x=>x.verdict==="pass"));assert.equal(observed.task.trace.outcome,"completed");
            assert.equal(observed.task.acceptanceReceipt.criteria.find(x=>x.id===preview.criteria[6].criterionId).status,"satisfied",
              "the original Keep the API parent must pass its native baseline gate");
          } else {
            assert.notEqual(observed.task.trace.outcome,"completed");
            const handoff=JSON.parse(fs.readFileSync(path.join(prepared.workspace,".pi/piagent-state/handoffs",`${observed.task.taskRunId}.json`)));
            assert.equal(handoff.state.completionApproved,false);assert.equal(handoff.nextSafeAction.action,"handoff");
            if(variant==="unsupported-import")assert.ok(receipts.every(x=>x.verdict!=="pass"));
            else assert.ok(receipts.some(x=>x.verdict==="fail"));
          }
        } finally { config.close(); }
      } finally { await runtime.close(); }
    });
  });
}
