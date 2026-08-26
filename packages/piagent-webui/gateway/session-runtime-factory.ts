import path from "node:path";

import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import type { PiSessionInfo } from "./session-catalog.ts";
import { preferAuthoritativePiagentGuard } from "./extension-authority.ts";
import { rpcUiContext } from "./rpc-ui-context.ts";

export type RuntimeHandle = { dispose(): Promise<void>; session?: any };
export type InitialSessionOptions = { modelRef: string | null; thinkingLevel: string };
export type RuntimeFactory = (info: PiSessionInfo, runtimeInstanceRef: string,
  sessionManager?: any, initialOptions?: InitialSessionOptions) => Promise<RuntimeHandle>;

export function createProductionRuntimeFactory(options: {
  host: any;
  agentDir: string;
  packageRoot: string;
  modelRuntime?: any;
}): RuntimeFactory {
  return async (info, _runtimeInstanceRef, sessionManager, initialOptions) => {
    let pendingInitialOptions = initialOptions;
    const guard = path.join(options.packageRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts");
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const requested = pendingInitialOptions;
      pendingInitialOptions = undefined;
      const services = await options.host.createAgentSessionServices({
        cwd, agentDir, modelRuntime: options.modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [guard],
          extensionsOverride: preferAuthoritativePiagentGuard(guard)
        }
      });
      const extensionErrors = services.resourceLoader.getExtensions().errors;
      if (extensionErrors.length) throw new Error("session-runtime-extension-load-failed");
      const models = requested?.modelRef ? services.modelRuntime?.getAvailableSnapshot?.() ?? [] : [];
      const model = requested?.modelRef ? models.find((value: any) => webUiModelRef(String(value.provider ?? ""),
        String(value.id ?? value.modelId ?? "")) === requested.modelRef) : undefined;
      if (requested?.modelRef && !model) throw new Error("session-model-unavailable");
      const created = await options.host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        ...(model ? { model } : {}), ...(requested ? { thinkingLevel: requested.thinkingLevel } : {}) });
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
