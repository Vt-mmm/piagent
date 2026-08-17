import { createHash } from "node:crypto";
import path from "node:path";

import { readContextTelemetry } from "../../piagent-core/extensions/context-engine.js";
import { activeSessionTask } from "../../piagent-core/extensions/task-state.js";
import { runtimeConnectionDefinitions, runtimeDocumentReadRoots, runtimeProtectedPaths } from "../../piagent-core/runtime/inspection/project-runtime-inspection.ts";
import { setRuntimeMcpEnabled } from "../../piagent-core/runtime/inspection/mcp-control.ts";
import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import { piApprovalBroker } from "../../piagent-core/runtime/inspection/approval-broker.ts";
import { attachmentCapability } from "../../piagent-core/runtime/input/attachment-store.ts";
import { CoreInspectionProvider } from "../server/core-inspection-provider.ts";
import { ReadModelNotFound, type WebUiReadModelProvider } from "../server/read-model-provider.ts";
import { isUserConversationSession, projectRefForCwd, sessionRefForPath, type PiSessionInfo } from "./session-catalog.ts";
import { nativeProjectPickerAvailable } from "./native-project-picker.ts";
import type { McpAuthBroker } from "./mcp-auth-broker.ts";
import { inspectWebSearchCapability } from "./ai-capability-inspection.ts";

type PiHost = {
  SessionManager: {
    listAll(): Promise<PiSessionInfo[]>;
    open(file: string): {
      getBranch(): unknown[];
      buildSessionContext(): { model: { provider: string; modelId: string } | null; thinkingLevel: string; messages: unknown[] };
    };
  };
  calculateContextTokens(usage: unknown): number;
  estimateTokens(message: unknown): number;
  getLatestCompactionEntry(entries: unknown[]): unknown | null;
};

type ModelRuntime = {
  getModel(provider: string, modelId: string): Record<string, unknown> | undefined;
  getAvailableSnapshot(): readonly Record<string, unknown>[];
};

type ProjectSource = { list(): Array<{ projectRef: string; placeRef: string; label: string }> };

const CACHE_LIMIT = 32;
const PUBLIC_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const EMPTY_REPLAY = {
  state: "current" as const,
  events: [],
  nextCursor: "inspection-start",
  latestCursor: "inspection-start",
  reasonCode: null
};

function inspectionRuntimeRef(gatewayInstanceRef: string, sessionRef: string): string {
  return `runtime.${createHash("sha256").update(`${gatewayInstanceRef}\0${sessionRef}`).digest("hex")}`;
}

function safeRead<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

function safeName(value: unknown): string {
  return redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
    || "Unnamed connection";
}

function safeModelId(value: unknown): string | null {
  if (typeof value !== "string" || !PUBLIC_MODEL_ID.test(value)) return null;
  return redactSensitiveText(value).redacted ? null : value;
}

function persistedContextUsage(host: PiHost, entries: unknown[], messages: unknown[], model: Record<string, unknown> | undefined) {
  const contextWindow = Number(model?.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const latestCompaction = host.getLatestCompactionEntry(entries);
  if (latestCompaction) {
    const boundary = entries.lastIndexOf(latestCompaction);
    let hasPostCompactionUsage = false;
    for (let index = entries.length - 1; index > boundary; index -= 1) {
      const entry = entries[index] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; usage?: unknown } } | undefined;
      const message = entry?.type === "message" ? entry.message : undefined;
      if (message?.role === "assistant" && message.usage && message.stopReason !== "aborted" && message.stopReason !== "error"
        && host.calculateContextTokens(message.usage) > 0) {
        hasPostCompactionUsage = true;
        break;
      }
    }
    if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
  }
  let lastUsageIndex = -1, tokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown; usage?: unknown } | undefined;
    if (message?.role !== "assistant" || !message.usage || message.stopReason === "aborted" || message.stopReason === "error") continue;
    const measured = host.calculateContextTokens(message.usage);
    if (measured > 0) { tokens = measured; lastUsageIndex = index; break; }
  }
  for (let index = lastUsageIndex + 1; index < messages.length; index += 1) tokens += host.estimateTokens(messages[index]);
  if (!Number.isFinite(tokens) || tokens < 0) return undefined;
  return { tokens, contextWindow, percent: tokens / contextWindow * 100 };
}

export class SessionInspectionRegistry {
  readonly #gatewayInstanceRef: string;
  readonly #host: PiHost;
  readonly #listSessions: () => Promise<PiSessionInfo[]>;
  readonly #openLiveSession: ((sessionRef: string) => ReturnType<PiHost["SessionManager"]["open"]> | null) | null;
  readonly #key: Buffer;
  readonly #packageRoot: string;
  readonly #agentDir?: string;
  readonly #models?: ModelRuntime;
  readonly #projects?: ProjectSource;
  readonly #mcpAuth?: McpAuthBroker;
  readonly #providers = new Map<string, { modifiedAt: string; provider: CoreInspectionProvider }>();

  constructor(options: { gatewayInstanceRef: string; host: PiHost; key: Buffer; packageRoot: string; agentDir?: string; models?: ModelRuntime; projects?: ProjectSource;
    mcpAuth?: McpAuthBroker; listSessions?: () => Promise<PiSessionInfo[]>;
    openLiveSession?: (sessionRef: string) => ReturnType<PiHost["SessionManager"]["open"]> | null }) {
    this.#gatewayInstanceRef = options.gatewayInstanceRef;
    this.#host = options.host;
    this.#listSessions = options.listSessions ?? (() => options.host.SessionManager.listAll());
    this.#openLiveSession = options.openLiveSession ?? null;
    this.#key = options.key;
    this.#packageRoot = options.packageRoot;
    this.#agentDir = options.agentDir;
    this.#models = options.models;
    this.#projects = options.projects;
    this.#mcpAuth = options.mcpAuth;
  }

  #connectionRef(server: { scope: string; origin: string; name: string }): string {
    return `mcp.${createHash("sha256").update(`${server.scope}\0${server.origin}\0${server.name}`).digest("hex")}`;
  }

  async #sessionInfo(sessionRef: string): Promise<PiSessionInfo> {
    const sessions = (await this.#listSessions()).filter(isUserConversationSession);
    const found = sessions.filter((candidate) => sessionRefForPath(this.#key, candidate.path) === sessionRef);
    if (found.length !== 1) throw new ReadModelNotFound();
    return found[0]!;
  }

  async connections(sessionRef: string): Promise<unknown> {
    const info = await this.#sessionInfo(sessionRef);
    const definitions = safeRead(() => runtimeConnectionDefinitions(info.cwd), { servers: [], unreadableLayerCount: 1 });
    const servers = await Promise.all(definitions.servers.slice(0, 100).map(async (server) => {
      const auth = await this.#mcpAuth?.describe(info.cwd, server.name) ?? { oauthSupported: false as const, authState: "unavailable" as const };
      return { connectionRef: this.#connectionRef(server), name: safeName(server.name), kind: "mcp" as const, scope: server.scope,
        origin: safeName(server.origin), transport: typeof server.entry.url === "string" ? "http" as const
          : typeof server.entry.command === "string" ? "stdio" as const : "unknown" as const,
        state: server.entry.enabled === false ? "disabled" as const : auth.authState === "connected" ? "connected" as const : "configured" as const,
        requiresApproval: server.requiresApproval, oauthSupported: auth.oauthSupported, authState: auth.authState,
        toggleSupported: !server.origin.startsWith("import:") };
    }));
    return {
      schemaVersion: 1,
      version: "piagent-session-connections-v1",
      generatedAt: new Date().toISOString(),
      sessionRef,
      state: definitions.unreadableLayerCount ? "degraded" : "ready",
      summary: { configured: servers.length, connected: null, approvalRequired: servers.filter((server) => server.requiresApproval).length },
      connections: servers,
      truncated: servers.length >= 100,
      reasonCode: definitions.unreadableLayerCount ? "one-or-more-connection-layers-unreadable" : null
    };
  }

  async executeConnectionCommand(input: unknown): Promise<unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("mcp-command-invalid");
    const command = input as Record<string, unknown>, keys = Object.keys(command);
    if (!keys.every((key) => ["action", "sessionRef", "connectionRef"].includes(key)) || keys.length !== 3
      || !["mcp.enable", "mcp.disable", "mcp.oauth"].includes(String(command.action))
      || typeof command.sessionRef !== "string" || typeof command.connectionRef !== "string") throw new Error("mcp-command-invalid");
    const info = await this.#sessionInfo(command.sessionRef), definitions = safeRead(() => runtimeConnectionDefinitions(info.cwd), { servers: [], unreadableLayerCount: 1 });
    const matches = definitions.servers.filter((server) => this.#connectionRef(server) === command.connectionRef);
    if (matches.length !== 1) throw new Error("mcp-connection-not-found");
    const server = matches[0]!;
    if (command.action === "mcp.oauth") {
      if (!this.#mcpAuth) throw new Error("mcp-oauth-unavailable");
      return await this.#mcpAuth.start({ sessionRef: command.sessionRef, connectionRef: command.connectionRef, cwd: info.cwd, name: server.name });
    }
    setRuntimeMcpEnabled({ projectPath: info.cwd, name: server.name, scope: server.scope, enabled: command.action === "mcp.enable" });
    return await this.connections(command.sessionRef);
  }

  async creationOptions(): Promise<unknown> {
    const sessions = (await this.#listSessions()).filter(isUserConversationSession);
    const projects = new Map<string, { projectRef: string; placeRef: string; label: string }>();
    for (const info of sessions) {
      if (!info.cwd) continue;
      const projectRef = projectRefForCwd(this.#key, info.cwd);
      if (!projects.has(projectRef)) projects.set(projectRef, { projectRef, placeRef: projectRef,
        label: safeName(path.basename(info.cwd) || "Project") });
    }
    for (const project of safeRead(() => this.#projects?.list() ?? [], [])) {
      if (!projects.has(project.projectRef)) projects.set(project.projectRef, project);
    }
    const availableModels = (this.#models?.getAvailableSnapshot() ?? []).slice(0, 300);
    const models = availableModels.flatMap((value) => {
      const provider = safeModelId(value.provider);
      const modelId = safeModelId(value.id);
      if (!provider || !modelId || typeof value.reasoning !== "boolean") return [];
      const mapping = value.thinkingLevelMap && typeof value.thinkingLevelMap === "object"
        ? value.thinkingLevelMap as Record<string, unknown> : {};
      const thinkingLevels = value.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .filter((level) => mapping[level] !== null && !(["xhigh", "max"].includes(level) && mapping[level] === undefined)) : ["off"];
      const inputs = Array.isArray(value.input) ? value.input.filter((item): item is string => typeof item === "string") : null;
      return [{ modelRef: webUiModelRef(provider, modelId), provider, modelId, displayName: safeName(value.name ?? modelId),
        reasoning: value.reasoning, imageInput: inputs ? inputs.includes("image") : null, thinkingLevels }];
    });
    return { schemaVersion: 1, version: "piagent-session-creation-options-v1", generatedAt: new Date().toISOString(),
      projects: [...projects.values()].slice(0, 200), models, webSearch: inspectWebSearchCapability({ agentDir: this.#agentDir, models: availableModels }),
      projectImport: nativeProjectPickerAvailable() ? { status: "available", reasonCode: null }
        : { status: "unavailable", reasonCode: "native-project-picker-unavailable" },
      reasonCode: projects.size ? null : "no-known-project" };
  }

  async provider(sessionRef: string): Promise<WebUiReadModelProvider> {
    const info = await this.#sessionInfo(sessionRef);
    const modifiedAt = info.modified.toISOString();
    const cached = this.#providers.get(sessionRef);
    if (cached?.modifiedAt === modifiedAt) return cached.provider;

    let manager: ReturnType<PiHost["SessionManager"]["open"]>;
    try { manager = this.#openLiveSession?.(sessionRef) ?? this.#host.SessionManager.open(info.path); }
    catch { throw new ReadModelNotFound(); }
    const context = safeRead(() => manager.buildSessionContext(), { model: null, thinkingLevel: "unknown", messages: [] });
    const model = context.model ? this.#models?.getModel(context.model.provider, context.model.modelId) : undefined;
    const entries = safeRead(() => manager.getBranch(), []);
    const contextUsage = safeRead(() => persistedContextUsage(this.#host, entries, context.messages, model), undefined);
    const eventStore = {
      retention: () => ({ eventRetentionCount: 0, eventRetentionSeconds: 0 }),
      currentCursor: () => null,
      resyncRequired: () => false,
      replay: () => EMPTY_REPLAY
    };
    const provider = new CoreInspectionProvider({
      cwd: info.cwd,
      sessionId: info.id,
      runtimeInstanceId: inspectionRuntimeRef(this.#gatewayInstanceRef, sessionRef),
      eventStore,
      task: () => safeRead(() => activeSessionTask(info.cwd, info.id), undefined),
      activityEvents: () => safeRead(() => readContextTelemetry(info.cwd, { limit: 5_000 }), []),
      sessionEntries: () => entries,
      protectedPaths: () => runtimeProtectedPaths(this.#packageRoot, info.cwd),
      // The document workspace lists the project plus whatever the operator
      // granted in the profile. Without this it silently shows the project only,
      // which reads as "the grant does not work" rather than "it was not asked for".
      documentReadRoots: () => safeRead(() => runtimeDocumentReadRoots(this.#packageRoot, info.cwd), []),
      // Derived from the model and the host, with no store instance involved:
      // the store for this session is built from the very snapshot this call
      // helps produce, so asking the store would be circular.
      attachmentCapability: () => attachmentCapability({
        images: Array.isArray(model?.input) && model.input.includes("image"), now: Date.now() }),
      contextUsage: () => contextUsage,
      model: () => model,
      thinkingLevel: () => context.thinkingLevel,
      approvalProjection: () => piApprovalBroker.projection(info.cwd, info.id),
      approvalDetail: (approvalRef) => piApprovalBroker.detail(info.cwd, info.id, approvalRef)
    });
    this.#providers.delete(sessionRef);
    this.#providers.set(sessionRef, { modifiedAt, provider });
    while (this.#providers.size > CACHE_LIMIT) this.#providers.delete(this.#providers.keys().next().value as string);
    return provider;
  }
}
