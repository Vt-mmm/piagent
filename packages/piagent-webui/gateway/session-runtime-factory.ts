import path from "node:path";

import type { PiSessionInfo } from "./session-catalog.ts";
import { preferAuthoritativePiagentGuard } from "./extension-authority.ts";
import { rpcUiContext } from "./rpc-ui-context.ts";

export type RuntimeHandle = { dispose(): Promise<void>; session?: any };
export type RuntimeFactory = (info: PiSessionInfo, runtimeInstanceRef: string,
  sessionManager?: any) => Promise<RuntimeHandle>;

export function createProductionRuntimeFactory(options: {
  host: any;
  agentDir: string;
  packageRoot: string;
  modelRuntime?: any;
}): RuntimeFactory {
  return async (info, _runtimeInstanceRef, sessionManager) => {
    const guard = path.join(options.packageRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts");
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const services = await options.host.createAgentSessionServices({
        cwd, agentDir, modelRuntime: options.modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [guard],
          extensionsOverride: preferAuthoritativePiagentGuard(guard)
        }
      });
      const extensionErrors = services.resourceLoader.getExtensions().errors;
      if (extensionErrors.length) throw new Error("session-runtime-extension-load-failed");
      const created = await options.host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const manager = sessionManager ?? options.host.SessionManager.open(info.path);
    const runtime = await options.host.createAgentSessionRuntime(createRuntime, {
      cwd: info.cwd,
      agentDir: options.agentDir,
      sessionManager: manager,
      sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: info.path }
    });
    const bind = async (session: any) => session.bindExtensions({ mode: "rpc", uiContext: rpcUiContext() });
    runtime.setRebindSession(bind);
    try { await bind(runtime.session); }
    catch (error) { await runtime.dispose().catch(() => undefined); throw error; }
    return runtime;
  };
}
