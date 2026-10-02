import { managedThinkingLevels } from '../../piagent-core/managed/capabilities.mjs';
import { ManagedBrokerClient } from '../../piagent-core/managed/broker-client.mjs';
import { ManagedSession } from '../../piagent-core/managed/session.mjs';
import fs from 'node:fs';

// Only called by the pinned launcher with Watch's non-secret import manifest.
// Each web session owns its own broker; no personal auth/model/resource loader.
export async function startManagedGateway({ config, configPath, cwd, agentDir, packageRoot, registerProject = true }) {
  // Agent Watch may hold another key of this member since the Gateway
  // started: a new conversation, or one that enrolls again, uses that key.
  const slot=()=>{try{const now=JSON.parse(fs.readFileSync(configPath,'utf8'));return /^[a-f0-9]{64}$/.test(now.profile_id)&&now.broker===config.broker?now.profile_id:config.profile_id;}catch{return config.profile_id;}};
  const newBroker=()=>new ManagedBrokerClient({executable:config.broker,profileID:slot()});
  // Agent Watch rewrites the binding's revision when the key or its harness
  // changes; a warm conversation then enrolls again before its next run.
  const bindingRevision=()=>{try{return String(JSON.parse(fs.readFileSync(configPath,'utf8')).configuration_revision??'')||null;}catch{return null;}};
  const probeBroker = newBroker();
  let probe;
  try {
    probe = await ManagedSession.create({sdkRoot:config.sdk_root,cwd,origin:config.origin,broker:probeBroker,agentDir,protectedRoots:[configPath,agentDir]});
    const { startPiagentGateway } = await import('./gateway-service.ts');
    const { rpcUiContext } = await import('./rpc-ui-context.ts');
    const { webUiModelRef } = await import('../../piagent-core/runtime/inspection/webui-snapshot.ts');
    const host=probe.api,models=probe.modelRuntime;
    const snapshot=models.getAvailableSnapshot.bind(models);
    models.getAvailableSnapshot=()=>snapshot().map(model=>({...model,managedThinkingLevels:managedThinkingLevels(probe.manifest,models,model)}));
    const factory=async(info,_instance,manager,initial)=>{
      if(initial?.modelRef && initial.modelRef!==webUiModelRef('agent_watch_managed','agent-watch-auto')) throw Error('managed-personal-switch-requires-new-session');
      const broker=newBroker();
      let runtime;
      try {
        runtime=await ManagedSession.create({sdkRoot:config.sdk_root,cwd:info.cwd,origin:config.origin,broker,agentDir,
          sessionManager:manager??host.SessionManager.open(info.path),protectedRoots:[configPath,agentDir],renewBroker:newBroker,bindingRevision});
        if(initial) runtime.session.setThinkingLevel(initial.thinkingLevel);
        await runtime.session.bindExtensions({mode:'rpc',uiContext:rpcUiContext()});
        return {session:runtime.session,dispose:()=>runtime.dispose()};
      } catch(error) { if(runtime) await runtime.dispose(); else await broker.dispose(); throw error; }
    };
    const gateway=await startPiagentGateway({packageRoot,agentDir,expectedPiVersion:'0.87.1',managed:{host,models,runtimeFactory:factory,project:registerProject?cwd:null}});
    return gateway;
  } finally { if(probe) await probe.dispose(); else await probeBroker.dispose(); }
}
