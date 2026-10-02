import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import { ManagedBrokerClient } from '../../packages/piagent-core/managed/broker-client.mjs';
import { ManagedSession } from '../../packages/piagent-core/managed/session.mjs';
const config = JSON.parse(fs.readFileSync(process.argv[2]));
let broker,runtime;
try {
 if(config.cli) {
  const entry=path.resolve(import.meta.dirname,'../../scripts/piagent-studio.mjs');
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const imported=path.join(path.dirname(process.argv[2]),'imported.json');
  const node=fs.realpathSync(process.execPath);
  fs.writeFileSync(imported,JSON.stringify({schema_version:1,model:'agent-watch-auto',profile_id:config.profileID,origin:config.origin,
   node,entrypoint:entry,node_sha256:hash(node),entrypoint_sha256:hash(entry),broker:config.broker,broker_sha256:hash(config.broker),sdk_root:config.sdkRoot}));
  const sessions=path.join(os.homedir(),'Library/Application Support/AgentWatch/ManagedSessions',config.profileID);
  assert.equal(fs.existsSync(sessions),false,'fixture must not touch an existing profile');
  try {
   const check=execFileSync(node,[entry,'--config',imported,'--project',config.project,'--check'],{encoding:'utf8',timeout:15000});
   assert.match(check,/no inference sent/);
   const output=execFileSync(node,[entry,'--config',imported,'--project',config.project,'--prompt',config.helpers?'Research and review this patch using both helpers':'alo 123'],{encoding:'utf8',timeout:15000});
   assert.match(output,/STUDIO_FIXTURE_OK/);
  } finally {fs.rmSync(sessions,{recursive:true,force:true});}
 } else if(config.web) {
  const {runWeb}=await import('./studio-managed-web-e2e.mjs');await runWeb(config,process.argv[2]);
 } else {
  broker = new ManagedBrokerClient({ executable: config.broker, profileID: config.profileID });
  runtime = await ManagedSession.create({ broker, cwd: config.project, origin: config.origin, sdkRoot: config.sdkRoot, protectedRoots: [process.argv[2], config.broker] });
  if (config.recovery) {
   const manager = runtime.session.sessionManager;
   const old = await broker.request('start', {operation_id:randomUUID(),effort:'medium',task_class:'simple'});
   manager.appendCustomEntry('agent-watch-run', {run_id:old.run_id,state:'active'});
   await runtime.dispose();runtime=null;
   broker = new ManagedBrokerClient({executable:config.broker,profileID:config.profileID});
   runtime = await ManagedSession.create({broker,cwd:config.project,origin:config.origin,sdkRoot:config.sdkRoot,sessionManager:manager,protectedRoots:[process.argv[2],config.broker]});
   assert.equal(runtime.grant.run_id,old.run_id);assert.ok(runtime.grant.fence>old.fence);
  }
  runtime.session.setThinkingLevel('medium');
  await runtime.session.prompt('alo 123');
  const last = runtime.session.messages.at(-1);
  if (last.stopReason !== 'stop') throw Error('managed-stream-fixture: '+JSON.stringify({stop:last.stopReason,error:last.errorMessage}));
  assert.match(JSON.stringify(last.content), /STUDIO_FIXTURE_OK/);
 }
 process.stdout.write('MANAGED_E2E_OK\n');
} catch (error) {
 // Synthetic fixture only, remove any credentials before returning diagnostics.
 const message=String(error?.message ?? 'managed-integration-failed').replace(/as_(run|device|live)_[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,4000);
 process.stderr.write(message+'\n');process.exitCode=1;
} finally { if(runtime) await runtime.dispose(); else await broker?.dispose(); }
