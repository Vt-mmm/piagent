import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Exercise the real reader with a disposable installation and Git workspace.
// Changing the fixture policy cannot alter the candidate under qualification.
test('diagnostic reconnect refuses stale policy, source, task and acceptance bindings', async t => {
 const install=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-diagnostic-reconnect-'));
 t.after(()=>fs.rmSync(install,{recursive:true,force:true}));
 const repository=path.resolve(import.meta.dirname,'..');
 fs.cpSync(path.join(repository,'packages/piagent-core'),path.join(install,'packages/piagent-core'),{recursive:true});
 fs.writeFileSync(path.join(install,'package.json'),'{"type":"module"}');
 fs.symlinkSync(path.join(repository,'node_modules'),path.join(install,'node_modules'),'dir');
 const load=relative=>import(pathToFileURL(path.join(install,'packages/piagent-core',relative)));
 const {installedDiagnosticPolicyDigest,validDiagnosticDelivery}=await load('runtime/recovery/diagnostic-delivery.ts');
 const {terminalUncertainSendReceipt}=await load('runtime/session/uncertain-send-continuation.ts');
 const {taskAcceptanceDisposition,taskHandoffIdentity}=await load('runtime/recovery/handoff-projection.ts');
 const {captureWorkspaceVerificationSnapshot}=await load('extensions/workspace-verification-snapshot.js');
const cwd=path.join(install,'project'); fs.mkdirSync(cwd);
const policy=path.join(install,'packages/piagent-core/policies/base-policy.json');
 const initialPolicy=JSON.parse(fs.readFileSync(policy)); initialPolicy.finalGate.acceptanceProofMode='diagnostic'; fs.writeFileSync(policy,JSON.stringify(initialPolicy));
const before=fs.readFileSync(policy);
try {
 fs.writeFileSync(path.join(cwd,'source.js'),'original');
 execFileSync('git',['init','-q',cwd]);
 execFileSync('git',['-C',cwd,'add','source.js']);
 execFileSync('git',['-C',cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const snap=captureWorkspaceVerificationSnapshot(cwd);assert.equal(snap.proofCapable,true);
 const task={taskId:'delivery',taskRunId:'delivery-1',sessionId:'session',sessionName:null,attempt:1,maxAttempts:1,changeMode:'source-change',changedFiles:['source.js'],trace:{outcome:'completed'},acceptanceReceipt:{criteria:[{id:'ac-1',hash:'a'.repeat(64),status:'pending',priority:'critical',obligation:'requested-behavior'}]}};
 const acceptance=taskAcceptanceDisposition(task);
 const d={mode:'diagnostic',qualityClaim:'withheld',policySha256:installedDiagnosticPolicyDigest(),acceptanceDigest:acceptance.dispositionDigest,pendingCriterionIds:['ac-1']};
 const handoff={identity:taskHandoffIdentity(task),state:{taskOutcome:'completed',completionApproved:false,gateDecision:'pass',missing:['acceptance-criteria-pending'],diagnosticDelivery:d},acceptance,tree:{currentDigest:snap.digest,workspaceRevisionDigest:snap.workspaceRevisionDigest},changedFiles:{current:['source.js']},nextSafeAction:{action:'completed'}};
 const read=(t=task,h=handoff)=>terminalUncertainSendReceipt(cwd,t,()=>h);
 const receipt=read();assert.ok(receipt);assert.equal(receipt.details.completionApproved,false);assert.match(receipt.content,/no quality claim/);
 assert.equal(validDiagnosticDelivery({...d,qualityClaim:'approved'},acceptance.dispositionDigest),false);
 assert.equal(validDiagnosticDelivery({...d,pendingCriterionIds:['ac-1','ac-1']},acceptance.dispositionDigest),false);
 assert.equal(read({...task,taskRunId:'other'}),undefined);
 assert.equal(read(task,{...handoff,state:{...handoff.state,diagnosticDelivery:{...d,policySha256:'f'.repeat(64)}}}),undefined);
 assert.equal(read(task,{...handoff,state:{...handoff.state,diagnosticDelivery:{...d,pendingCriterionIds:['other']}}}),undefined);
 fs.writeFileSync(policy,JSON.stringify({finalGate:{acceptanceProofMode:'enforce'}}));assert.equal(read(),undefined);
 fs.writeFileSync(policy,before);assert.ok(read());
 fs.writeFileSync(path.join(cwd,'source.js'),'modified');assert.equal(read(),undefined);
 console.log('Diagnostic delivery controls PASS: pending/no-claim, invalid metadata, wrong task, wrong policy, wrong criteria, enforce switch, restored policy, changed source.');
} finally { fs.writeFileSync(policy,before);fs.rmSync(cwd,{recursive:true,force:true}); }

});
