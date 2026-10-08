import { managedProjection } from './managed-projection.ts';
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import type { PiagentGatewayCapabilityHandshakeV1 } from "../contracts/generated/gateway-capabilities-v1.ts";
import type { PiagentWebUICanonicalSnapshotV1 } from "../contracts/generated/snapshot-v1.ts";
import { startLoopbackServer } from "../server/loopback-server.ts";
import { startGatewayControlSocket, type GatewayControlResponse } from "./control-socket.ts";
import { loadPinnedPiHost } from "./pi-host.ts";
import { UpdateCenter } from "./update-center.ts";
import {
  gatewayProfileState,
  profileRef,
  readOrCreateCatalogKey,
  removeGatewayDescriptor,
  writeGatewayDescriptor,
  type GatewayDescriptor
} from "./profile-state.ts";
import { buildSessionCatalog, projectRefForCwd } from "./session-catalog.ts";
import { suggestPaths } from "./path-suggestions.ts";
import { GitBranchError, listBranches, switchBranch, type SwitchRequest } from "./git-branches.ts";
import { childRepositories, childRepositoryFolder } from "./git-repositories.ts";
import { listAgentCommands } from "../../piagent-core/runtime/resources/agent-resources.mjs";
import { sessionRefForPath } from "../ownership/session-refs.ts";
import { SessionMetadataStore } from "./session-metadata-store.ts";
import { GatewayProtocolService } from "./gateway-protocol-service.ts";
import { SessionLeaseStore } from "./session-lease-store.ts";
import { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";
import { cachedSessionLister } from "./session-list-cache.ts";
import { cachedSessionFacts } from "./session-file-facts.ts";
import { buildSessionLiveState } from "./session-live-state.ts";
import { SessionCommandStore } from "./session-command-store.ts";
import { SessionCommandController } from "./session-command-controller.ts";
import { RuntimeCommandController } from "./runtime-command-controller.ts";
import { GatewayEventStore } from "./gateway-events.ts";
import { SessionInspectionRegistry } from "./session-inspection-registry.ts";
import { SessionAttachmentRegistry } from "./session-attachment-registry.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { pickNativeProjectFolders } from "./native-project-picker.ts";
import { CompanyRelay, type CompanyConnector } from "./company-relay.ts";
import { ProviderAuthBroker } from "./provider-auth-broker.ts";
import { McpAuthBroker } from "./mcp-auth-broker.ts";
import type { ScopedBrokerRouter, RuntimeFactory } from "./session-runtime-factory.ts";

function unavailable(reasonCode: string) {
  return { status: "unavailable" as const, version: null, reasonCode };
}

function available(version = 1) { return { status: "available" as const, version, reasonCode: null }; }

function safeModelLabel(value: unknown): string {
  return (redactSensitiveText(String(value ?? "Model")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() || "Model").slice(0, 120);
}

function capabilities(gatewayInstanceRef: string, runtimeAvailable = false, managed = false): PiagentGatewayCapabilityHandshakeV1 {
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
        setModel: runtimeAvailable && !managed ? available() : unavailable("model-managed-by-studio"),
        setThinking: runtimeAvailable ? available() : unavailable("session-runtime-not-enabled"),
        // A company conversation offers "Ask first" or Bypass (no read-only).
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

function packageVersion(root: string): string | undefined {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version); } catch { return undefined; }
}

export async function startPiagentGateway(options: {
  packageRoot: string;
  expectedPiVersion: string;
  agentDir?: string;
  staticRoot?: string;
  scopedBrokerRouter?: ScopedBrokerRouter;
  managed?: { host: any; models: any; runtimeFactory: RuntimeFactory; project: string | null };
  // Company sessions relayed into this dashboard (the dashboard entry passes
  // the Agent Watch binding; omitted: none).
  company?: CompanyConnector;
}): Promise<{ descriptor: GatewayDescriptor; wait(): Promise<void>; close(): Promise<void> }> {
  const state = gatewayProfileState(options.agentDir);
  process.env.PI_CODING_AGENT_DIR = state.agentDir;
  const key = readOrCreateCatalogKey(state);
  const metadata = new SessionMetadataStore(state.root, key);
  const projects = new ProjectRegistry(state.root, key);
  const gatewayInstanceRef = `gateway_${process.pid}_${randomBytes(24).toString("base64url")}`;
  const staticRoot = options.staticRoot ?? path.join(options.packageRoot, "packages", "piagent-webui", "dist", "client");
  if (!fs.existsSync(path.join(staticRoot, "index.html"))) throw new Error("gateway-webui-build-missing");

  let descriptor: GatewayDescriptor | null = null;
  let loopback: Awaited<ReturnType<typeof startLoopbackServer>> | null = null;
  let control: Awaited<ReturnType<typeof startGatewayControlSocket>> | null = null;
  let runtimes: SessionRuntimeSupervisor | null = null;
  let mcpAuth: McpAuthBroker | null = null;
  let attachments: SessionAttachmentRegistry | null = null;
  let relay: CompanyRelay | null = null;
  let updates: UpdateCenter | null = null;
  let closing: Promise<void> | null = null;
  let settleWait: (() => void) | null = null;
  const waited = new Promise<void>((resolve) => { settleWait = resolve; });

  const close = async () => {
    if (closing) return await closing;
    closing = (async () => {
      removeGatewayDescriptor(state, gatewayInstanceRef);
      relay?.close(); updates?.close();
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
      if (request.action === "project.register" || request.action === "project.paths") {
        if (!options.managed || !runtimes) return { ok: false, error: "project-control-unavailable" };
        if (request.action === "project.register") {
          try { return reply(projects.register(request.cwd)); } catch { return { ok: false, error: "project-import-folder-invalid" }; }
        }
        // Registered folders and the folders of existing sessions.
        return runtimes.listSessions().then((sessions) => {
          const paths = new Map(projects.list().map((item) => [item.projectRef, projects.resolve(item.projectRef)]));
          for (const info of sessions) if (typeof info.cwd === "string") paths.set(projectRefForCwd(key, info.cwd), info.cwd);
          return reply([...paths].filter(([, cwd]) => cwd).map(([projectRef, cwd]) => ({ projectRef, cwd })));
        }, () => ({ ok: false as const, error: "project-control-unavailable" }));
      }
      setImmediate(() => { void close(); });
      return reply({ stopping: true, gatewayInstanceRef });
    }
  });

  try {
    const host = options.managed?.host ?? await loadPinnedPiHost(options.expectedPiVersion);
    const inspectionModels = options.managed?.models ?? await host.ModelRuntime.create({
      authPath: path.join(state.agentDir, "auth.json"),
      modelsPath: path.join(state.agentDir, "models.json"),
      allowModelNetwork: false
    });
    const providerAuth = new ProviderAuthBroker(inspectionModels);
    mcpAuth = new McpAuthBroker(state.agentDir);
    const leases = new SessionLeaseStore(state.root, key);
    const events = new GatewayEventStore();
    if (options.managed?.project) projects.register(options.managed.project);
    runtimes = new SessionRuntimeSupervisor({
      gatewayInstanceRef, key, leases, listSessions: cachedSessionLister((dir) => host.SessionManager.listAll(dir), path.join(state.agentDir, 'sessions'), Boolean(options.managed)),
      host, agentDir: state.agentDir, packageRoot: options.packageRoot, modelRuntime: inspectionModels, events,
      runtimeFactory: options.managed?.runtimeFactory,
      sessionDirectory: options.managed ? path.join(state.agentDir, 'sessions') : undefined,
      scopedBrokerRouter: options.scopedBrokerRouter,
      resolveProject: (projectRef) => projects.resolve(projectRef)
    });
    const sessionFacts = (manager: { buildSessionContext(): any; getBranch(): any[] }) => {
      const context = manager.buildSessionContext();
      return { model: context.model ? { provider: String(context.model.provider), modelId: String(context.model.modelId) } : null,
        thinkingLevel: context.thinkingLevel, managed: managedProjection(context, manager.getBranch()) };
    };
    const fileFacts = cachedSessionFacts((file) => sessionFacts(host.SessionManager.open(file)));
    const readCatalog = () => buildSessionCatalog({
      gatewayInstanceRef,
      key,
      listSessions: () => runtimes!.listSessions(),
      readMetadata: () => metadata.read(),
      readOwnership: (sessionRef) => runtimes!.ownership(sessionRef),
      readSessionOptions: (info) => {
        try {
          // A session running here may not have flushed its model and thinking
          // entries yet; its live manager has them, the file does not.
          const live = runtimes!.liveSessionManager(sessionRefForPath(key, info.path));
          const facts = live ? sessionFacts(live) : fileFacts(info.path);
          const model = facts.model ? inspectionModels.getModel(facts.model.provider, facts.model.modelId) : null;
          const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(facts.thinkingLevel))
            ? facts.thinkingLevel : "unknown";
          return { modelLabel: model ? safeModelLabel(model.name ?? model.id ?? facts.model?.modelId) : null,
            thinkingLevel: thinking, ...facts.managed };
        } catch { return { modelLabel: null, thinkingLevel: "unknown" }; }
      }
    });
    runtimes.setProjectionReader(async (sessionRef) => {
      const catalog = await readCatalog(), session = catalog.sessions.find((item) => item.sessionRef === sessionRef);
      if (catalog.state !== "ready" || !session) throw new Error("session-projection-unavailable");
      return { sessionRevision: session.sessionRevision, liveState: session.liveState };
    });
    relay = options.managed || !options.company ? null : new CompanyRelay({
      connector: options.company,
      events, hubProject: (cwd) => projectRefForCwd(key, cwd),
      folder: async (projectRef) => projects.resolve(projectRef)
        ?? (await runtimes!.listSessions()).find((info) => projectRefForCwd(key, info.cwd) === projectRef)?.cwd ?? null });
    // Every revision the browser sees and sends back is the merged one.
    const hubCatalog = relay ? async () => relay!.merge(await readCatalog()) : readCatalog;
    const company = (sessionRef: unknown) => !!relay?.owns(sessionRef);
    const projectFolder = async (projectRef: string) => projects.resolve(projectRef)
      ?? (await runtimes!.listSessions()).find((info) => typeof info.cwd === "string" && projectRefForCwd(key, info.cwd) === projectRef)?.cwd
      ?? (relay ? (await relay.folders()).find((folder) => projectRefForCwd(key, folder) === projectRef) : undefined);
    const relayPost = (path: string, body: unknown) => relay!.json("POST", path, body);
    const runningInProject = async (projectRef: string) => (await hubCatalog()).sessions.filter((row) => row.projectRef === projectRef
      && !row.archived && ["running", "waiting-approval", "paused"].includes(row.liveState)).length;
    const commands = new SessionCommandController({ catalog: hubCatalog, runtimes, metadata,
      store: new SessionCommandStore(state.root, key), events,
      // Resolved at call time: the attachment registry is built after this
      // controller, because it reads sessions through the inspection registry.
      prepareAttachments: (sessionRef, refs, messageRequestId, text) => {
        if (!attachments) throw new Error("session-attachment-unavailable");
        return attachments.reserveForPrompt(sessionRef, refs, messageRequestId, text);
      } });
    const runtimeCommands = new RuntimeCommandController({ catalog: readCatalog, runtimes, events });
    const protocol = new GatewayProtocolService({ capabilities: () => capabilities(gatewayInstanceRef, true, !!options.managed), catalog: hubCatalog,
      events, command: relay ? { execute: (command) => relay!.handles(command)
        ? relay!.command(command as Record<string, unknown>, async () => (await hubCatalog()).catalogRevision) : commands.execute(command) } : commands });
    const inspections = new SessionInspectionRegistry({ gatewayInstanceRef, host, key, packageRoot: options.packageRoot, agentDir: state.agentDir,
      models: inspectionModels, projects, mcpAuth, listSessions: () => runtimes!.listSessions(),
      openLiveSession: (sessionRef) => runtimes!.liveSessionManager(sessionRef),
      operationLiveness: (sessionRef) => runtimes!.currentOperation(sessionRef) ? "running" : "idle" });
    // Staged bytes live beside the inspection projection they were checked
    // against, so both read the same session through the same registry.
    attachments = new SessionAttachmentRegistry({
      inspect: async (sessionRef) => await (await inspections.provider(sessionRef)).snapshot() as PiagentWebUICanonicalSnapshotV1
    });
    // Piagent's own updates: Pi and Piagent together, never while a turn runs.
    updates = new UpdateCenter({ packageRoot: options.packageRoot, piVersion: options.expectedPiVersion, managed: Boolean(options.managed),
      busy: async () => runtimes!.currentOperations().length + (relay ? (await relay.operations()).length : 0) });
    updates.start();
    loopback = await startLoopbackServer({
      staticRoot,
      mode: "gateway",
      readCapabilities: () => capabilities(gatewayInstanceRef, true, !!options.managed),
      readSessionCatalog: hubCatalog,
      // Company settlements arrive as re-published events; running company
      // operations are read from its Gateway.
      readSessionLiveState: async () => {
        const companyOperations = relay ? await relay.operations() : [];
        const live = buildSessionLiveState({ gatewayInstanceRef, eventSequence: events.stateVersion,
          operations: runtimes!.currentOperations(), settlements: events.recentOperationSettlements() });
        return companyOperations.length ? { ...live, operations: [...live.operations, ...companyOperations] } : live;
      },
      readSessionCreationOptions: async () => {
        if (!relay) return inspections.creationOptions();
        // A folder with company conversations is a dashboard project too, so
        // a new chat there (company or personal) can be started from here.
        for (const folder of await relay.folders()) { try { projects.register(folder); } catch { /* moved or unreadable */ } }
        const options = await inspections.creationOptions() as { models: unknown[] };
        return { ...options, models: [...await relay.models(), ...options.models] };
      },
      relaySessionRead: relay ? async (sessionRef, path) => company(sessionRef)
        ? await relay!.http("GET", `/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection${path}`) : null : undefined,
      readSessionModel: (sessionRef) => inspections.provider(sessionRef),
      readSessionConnections: (sessionRef) => inspections.connections(sessionRef),
      executeSessionConnection: (command) => {
        if (options.managed) throw new Error('connections-managed-by-studio');
        return company((command as { sessionRef?: unknown } | null)?.sessionRef) ? relayPost("/api/v1/session-connections", command)
          : inspections.executeConnectionCommand(command);
      },
      executeRuntimeCommand: (command) => company((command as { sessionRef?: unknown } | null)?.sessionRef)
        ? relayPost("/api/v1/runtime-commands", command) : runtimeCommands.execute(command),
      executeSessionAttachment: (sessionRef, command) => company(sessionRef)
        ? relayPost(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/attachments`, command) : attachments.execute(sessionRef, command),
      // The main agent's questions to the member, read and answered where the
      // conversation runs (the company Gateway for a company conversation).
      readSessionQuestions: (sessionRef) => company(sessionRef)
        ? relay!.json("GET", `/api/v1/sessions/${encodeURIComponent(sessionRef)}/questions`) : runtimes!.questions(sessionRef),
      // What an @ or a / in the composer offers, under a folder this dashboard
      // knows: an imported project or the folder of a conversation (company
      // ones too).
      suggestPaths: async (projectRef, query) => {
        const root = await projectFolder(projectRef);
        return root ? await suggestPaths({ root, query }) : null;
      },
      listCommands: async (projectRef) => {
        const root = await projectFolder(projectRef);
        return root ? { commands: listAgentCommands({ cwd: root }) } : null;
      },
      // The project's Git branches and a switch between them. A switch waits
      // until no conversation in the folder runs (company ones included): the
      // agent would find its files changed under it.
      // A folder that is not a repository answers with the repositories one
      // level down; `repository` then names the one to read or switch.
      listBranches: async (projectRef, repository) => {
        const root = await projectFolder(projectRef);
        if (!root) return null;
        const folder = repository === null ? root : childRepositoryFolder(root, repository);
        if (!folder) throw new GitBranchError("not-a-git-repository");
        const [list, running] = await Promise.all([listBranches(folder), runningInProject(projectRef)]);
        if (list) return { ...list, running, ...(repository === null ? {} : { name: repository }) };
        const repositories = repository === null ? await Promise.all(childRepositories(root).map(async (child) => {
          const branches = await listBranches(path.join(root, child.name));
          return { name: child.name, head: child.head, changedFiles: branches?.changedFiles ?? 0 };
        })) : [];
        return { repository: false, running, repositories };
      },
      switchBranch: async (projectRef, request) => {
        const root = await projectFolder(projectRef);
        if (!root) return null;
        const value = request as (Partial<SwitchRequest> & { repository?: string }) | null;
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.branch !== "string"
          || Object.keys(value).some((name) => !["branch", "create", "remote", "repository"].includes(name))
          || (value.repository !== undefined && typeof value.repository !== "string")
          || (value.create !== undefined && typeof value.create !== "boolean")
          || (value.remote !== undefined && value.remote !== null && typeof value.remote !== "string")) throw new GitBranchError("branch-request-invalid");
        const folder = value.repository === undefined ? root : childRepositoryFolder(root, value.repository);
        if (!folder || !(await listBranches(folder))) throw new GitBranchError("not-a-git-repository");
        if (await runningInProject(projectRef) > 0) throw new GitBranchError("branch-switch-blocked-running");
        const head = await switchBranch(folder, { branch: value.branch, create: value.create === true, remote: value.remote ?? null });
        events.publish("catalog.changed", { reasonCode: "git-branch-switched" });
        return { head, branches: await listBranches(folder) };
      },
      updates: { status: () => updates!.status(), check: () => updates!.check(), apply: (request) => updates!.apply(request) },
      answerSessionQuestion: (sessionRef, questionRef, answer) => company(sessionRef)
        ? relayPost(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/questions/${encodeURIComponent(questionRef)}/answer`, answer)
        : runtimes!.answerQuestion(sessionRef, questionRef, answer),
      // Approval refs carry no session; a company approval is not pending here.
      executeApproval: async (approvalRef, decision) => {
        try { return await runtimes!.decideApproval(approvalRef, decision); }
        catch (error) {
          if (!relay || (error as Error).message !== "approval-not-pending") throw error;
          return await relayPost(`/api/v1/approvals/${encodeURIComponent(approvalRef)}/decision`, decision);
        }
      },
      readMcpAuthJob: (jobRef) => mcpAuth!.read(jobRef),
      cancelMcpAuthJob: (jobRef) => mcpAuth!.cancel(jobRef),
      readProviderAuthCatalog: () => options.managed ? { ...providerAuth.catalog(), providers: [], reasonCode: 'personal-oauth-requires-personal-session' } : providerAuth.catalog(),
      readProviderAuthJob: (jobRef) => providerAuth.read(jobRef),
      executeProviderAuth: (command) => {
        if (options.managed) throw new Error('personal-oauth-requires-personal-session');
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
      ...(relay ? { readCompanyStatus: () => relay!.status(), executeCompanyConnect: async () => { await relay!.connect(true); return relay!.status(); } } : {}),
      gatewayProtocol: protocol
    });
    descriptor = {
      version: "piagent-gateway-descriptor-v1",
      gatewayInstanceRef,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      origin: loopback.origin,
      controlSocket: state.controlSocket,
      profileRef: profileRef(state, key),
      packageVersion: packageVersion(options.packageRoot)
    };
    writeGatewayDescriptor(state, descriptor);
    relay?.start();
  } catch (error) {
    await close();
    throw error;
  }

  return { descriptor, wait: () => waited, close };
}
