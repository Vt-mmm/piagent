import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import type { PiagentGatewayCapabilityHandshakeV1 } from "../contracts/generated/gateway-capabilities-v1.ts";
import type { PiagentWebUICanonicalSnapshotV1 } from "../contracts/generated/snapshot-v1.ts";
import { startLoopbackServer } from "../server/loopback-server.ts";
import { startGatewayControlSocket, type GatewayControlResponse } from "./control-socket.ts";
import { loadPinnedPiHost } from "./pi-host.ts";
import {
  gatewayProfileState,
  profileRef,
  readOrCreateCatalogKey,
  removeGatewayDescriptor,
  writeGatewayDescriptor,
  type GatewayDescriptor
} from "./profile-state.ts";
import { buildSessionCatalog } from "./session-catalog.ts";
import { SessionMetadataStore } from "./session-metadata-store.ts";
import { GatewayProtocolService } from "./gateway-protocol-service.ts";
import { SessionLeaseStore } from "./session-lease-store.ts";
import { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";
import { buildSessionLiveState } from "./session-live-state.ts";
import { SessionCommandStore } from "./session-command-store.ts";
import { SessionCommandController } from "./session-command-controller.ts";
import { RuntimeCommandController } from "./runtime-command-controller.ts";
import { GatewayEventStore } from "./gateway-events.ts";
import { SessionInspectionRegistry } from "./session-inspection-registry.ts";
import { SessionAttachmentRegistry } from "./session-attachment-registry.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { pickNativeProjectFolders } from "./native-project-picker.ts";
import { ProviderAuthBroker } from "./provider-auth-broker.ts";
import { McpAuthBroker } from "./mcp-auth-broker.ts";

function unavailable(reasonCode: string) {
  return { status: "unavailable" as const, version: null, reasonCode };
}

function available(version = 1) { return { status: "available" as const, version, reasonCode: null }; }

function safeModelLabel(value: unknown): string {
  return (redactSensitiveText(String(value ?? "Model")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() || "Model").slice(0, 120);
}

function capabilities(gatewayInstanceRef: string, runtimeAvailable = false): PiagentGatewayCapabilityHandshakeV1 {
  return {
    schemaVersion: 1,
    version: "piagent-gateway-capabilities-v1",
    generatedAt: new Date().toISOString(),
    gatewayInstanceRef,
    protocol: { minimum: 1, maximum: 1, selected: 1, compatibility: "ready" },
    mode: runtimeAvailable ? "full" : "read-only",
    capabilities: {
      catalog: available(),
      events: available(),
      terminalAdapter: runtimeAvailable ? available() : unavailable("terminal-adapter-not-enabled"),
      sessionRuntime: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
      sessionActions: {
        create: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        send: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        abort: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        setModel: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        setThinking: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        setPermission: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        rename: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        pin: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        archive: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        unarchive: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        fork: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        acquire: runtimeAvailable ? available() : unavailable("session-owner-lease-not-enabled"),
        release: runtimeAvailable ? available() : unavailable("session-owner-lease-not-enabled")
      }
    },
    reasonCode: null
  };
}

export async function startPiagentGateway(options: {
  packageRoot: string;
  expectedPiVersion: string;
  agentDir?: string;
}): Promise<{ descriptor: GatewayDescriptor; wait(): Promise<void>; close(): Promise<void> }> {
  const state = gatewayProfileState(options.agentDir);
  process.env.PI_CODING_AGENT_DIR = state.agentDir;
  const key = readOrCreateCatalogKey(state);
  const metadata = new SessionMetadataStore(state.root, key);
  const projects = new ProjectRegistry(state.root, key);
  const gatewayInstanceRef = `gateway_${process.pid}_${randomBytes(24).toString("base64url")}`;
  const staticRoot = path.join(options.packageRoot, "packages", "piagent-webui", "dist", "client");
  if (!fs.existsSync(path.join(staticRoot, "index.html"))) throw new Error("gateway-webui-build-missing");

  let descriptor: GatewayDescriptor | null = null;
  let loopback: Awaited<ReturnType<typeof startLoopbackServer>> | null = null;
  let control: Awaited<ReturnType<typeof startGatewayControlSocket>> | null = null;
  let runtimes: SessionRuntimeSupervisor | null = null;
  let mcpAuth: McpAuthBroker | null = null;
  let attachments: SessionAttachmentRegistry | null = null;
  let closing: Promise<void> | null = null;
  let settleWait: (() => void) | null = null;
  const waited = new Promise<void>((resolve) => { settleWait = resolve; });

  const close = async () => {
    if (closing) return await closing;
    closing = (async () => {
      removeGatewayDescriptor(state, gatewayInstanceRef);
      await loopback?.close().catch(() => undefined);
      // Staged bytes are private temp files. Closing deletes them rather than
      // leaving a directory per session behind for the TTL sweep that will never
      // run once this process is gone.
      try { attachments?.close(); } catch { /* shutdown never fails on cleanup */ }
      await mcpAuth?.close().catch(() => undefined);
      await runtimes?.close().catch(() => undefined);
      await control?.close().catch(() => undefined);
      settleWait?.();
    })();
    return await closing;
  };

  const reply = (value: unknown): GatewayControlResponse => ({ ok: true, value });
  control = await startGatewayControlSocket({
    socketPath: state.controlSocket,
    handle(request) {
      if (request.action === "health") return reply(descriptor ?? { state: "starting", gatewayInstanceRef });
      if (request.action === "issue-launch-url") {
        if (!loopback) return { ok: false, error: "gateway-starting" };
        return reply({ launchUrl: loopback.issueLaunchUrl(), gatewayInstanceRef });
      }
      setImmediate(() => { void close(); });
      return reply({ stopping: true, gatewayInstanceRef });
    }
  });

  try {
    const host = await loadPinnedPiHost(options.expectedPiVersion);
    const inspectionModels = await host.ModelRuntime.create({
      authPath: path.join(state.agentDir, "auth.json"),
      modelsPath: path.join(state.agentDir, "models.json"),
      allowModelNetwork: false
    });
    const providerAuth = new ProviderAuthBroker(inspectionModels);
    mcpAuth = new McpAuthBroker(state.agentDir);
    const leases = new SessionLeaseStore(state.root, key);
    const events = new GatewayEventStore();
    runtimes = new SessionRuntimeSupervisor({
      gatewayInstanceRef, key, leases, listSessions: () => host.SessionManager.listAll(),
      host, agentDir: state.agentDir, packageRoot: options.packageRoot, modelRuntime: inspectionModels, events,
      resolveProject: (projectRef) => projects.resolve(projectRef)
    });
    const readCatalog = () => buildSessionCatalog({
      gatewayInstanceRef,
      key,
      listSessions: () => runtimes!.listSessions(),
      readMetadata: () => metadata.read(),
      readOwnership: (sessionRef) => runtimes!.ownership(sessionRef),
      readSessionOptions: (info) => {
        try {
          const context = host.SessionManager.open(info.path).buildSessionContext();
          const model = context.model ? inspectionModels.getModel(context.model.provider, context.model.modelId) : null;
          const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(context.thinkingLevel))
            ? context.thinkingLevel : "unknown";
          return { modelLabel: model ? safeModelLabel(model.name ?? model.id ?? context.model?.modelId) : null,
            thinkingLevel: thinking };
        } catch { return { modelLabel: null, thinkingLevel: "unknown" }; }
      }
    });
    runtimes.setProjectionReader(async (sessionRef) => {
      const catalog = await readCatalog(), session = catalog.sessions.find((item) => item.sessionRef === sessionRef);
      if (catalog.state !== "ready" || !session) throw new Error("session-projection-unavailable");
      return { sessionRevision: session.sessionRevision, liveState: session.liveState };
    });
    const commands = new SessionCommandController({ catalog: readCatalog, runtimes, metadata,
      store: new SessionCommandStore(state.root, key), events,
      // Resolved at call time: the attachment registry is built after this
      // controller, because it reads sessions through the inspection registry.
      prepareAttachments: (sessionRef, refs, messageRequestId, text) => {
        if (!attachments) throw new Error("session-attachment-unavailable");
        return attachments.reserveForPrompt(sessionRef, refs, messageRequestId, text);
      } });
    const runtimeCommands = new RuntimeCommandController({ catalog: readCatalog, runtimes, events });
    const protocol = new GatewayProtocolService({ capabilities: () => capabilities(gatewayInstanceRef, true), catalog: readCatalog,
      events, command: commands });
    const inspections = new SessionInspectionRegistry({ gatewayInstanceRef, host, key, packageRoot: options.packageRoot, agentDir: state.agentDir,
      models: inspectionModels, projects, mcpAuth, listSessions: () => runtimes!.listSessions(),
      openLiveSession: (sessionRef) => runtimes!.liveSessionManager(sessionRef) });
    // Staged bytes live beside the inspection projection they were checked
    // against, so both read the same session through the same registry.
    attachments = new SessionAttachmentRegistry({
      inspect: async (sessionRef) => await (await inspections.provider(sessionRef)).snapshot() as PiagentWebUICanonicalSnapshotV1
    });
    loopback = await startLoopbackServer({
      staticRoot,
      mode: "gateway",
      readCapabilities: () => capabilities(gatewayInstanceRef, true),
      readSessionCatalog: readCatalog,
      readSessionLiveState: () => buildSessionLiveState({ gatewayInstanceRef, eventSequence: events.stateVersion,
        operations: runtimes!.currentOperations(), settlements: events.recentOperationSettlements() }),
      readSessionCreationOptions: () => inspections.creationOptions(),
      readSessionModel: (sessionRef) => inspections.provider(sessionRef),
      readSessionConnections: (sessionRef) => inspections.connections(sessionRef),
      executeSessionConnection: (command) => inspections.executeConnectionCommand(command),
      executeRuntimeCommand: (command) => runtimeCommands.execute(command),
      executeSessionAttachment: (sessionRef, command) => attachments.execute(sessionRef, command),
      executeApproval: (approvalRef, decision) => runtimes!.decideApproval(approvalRef, decision),
      readMcpAuthJob: (jobRef) => mcpAuth!.read(jobRef),
      cancelMcpAuthJob: (jobRef) => mcpAuth!.cancel(jobRef),
      readProviderAuthCatalog: () => providerAuth.catalog(),
      readProviderAuthJob: (jobRef) => providerAuth.read(jobRef),
      executeProviderAuth: (command) => {
        const action = command && typeof command === "object" && !Array.isArray(command) ? (command as Record<string, unknown>).action : null;
        if (action === "provider-auth.start") return providerAuth.start(command);
        if (action === "provider-auth.respond") return providerAuth.respond(command);
        if (action === "provider-auth.cancel") return providerAuth.cancel(command);
        throw new Error("provider-auth-command-invalid");
      },
      executeProjectImport: async () => {
        const imported = await pickNativeProjectFolders();
        const registered = imported.map((folder) => projects.register(folder));
        const project = registered[0]!;
        events.publish("catalog.changed", { reasonCode: "project-imported" });
        return { schemaVersion: 1, version: "piagent-project-import-result-v1", importedAt: new Date().toISOString(), project, projects: registered };
      },
      gatewayProtocol: protocol
    });
    descriptor = {
      version: "piagent-gateway-descriptor-v1",
      gatewayInstanceRef,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      origin: loopback.origin,
      controlSocket: state.controlSocket,
      profileRef: profileRef(state, key)
    };
    writeGatewayDescriptor(state, descriptor);
  } catch (error) {
    await close();
    throw error;
  }

  return { descriptor, wait: () => waited, close };
}
