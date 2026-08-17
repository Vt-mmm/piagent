import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveLocalStatePath, ensurePrivateStateDirectory } from "../../piagent-core/extensions/local-state-path.js";
import { loadProjectContextIndexPolicy, effectiveProtectedPaths } from "../../piagent-core/extensions/context-index-policy.js";
import { readContextTelemetry } from "../../piagent-core/extensions/context-engine.js";
import { activeSessionTask, workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../piagent-core/extensions/task-lifecycle.js";
import { piApprovalBroker, type ApprovalBrokerEvent, type ApprovalAuthority } from "../../piagent-core/runtime/inspection/approval-broker.ts";
import { RuntimeEventStore, type RuntimeEventDraft } from "../../piagent-core/runtime/inspection/runtime-event-store.ts";
import { inspectTaskControlState } from "../../piagent-core/runtime/inspection/task-control-journal.ts";
import { webUiProjectRef, webUiSessionRef, webUiTaskRevision } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { piSourceMutationGuard } from "../../piagent-core/runtime/policy/source-mutation-guard.ts";
import { CoreInspectionProvider } from "../server/core-inspection-provider.ts";
import type { SourceView } from "../server/read-model-provider.ts";
import { SameSessionPiBridge, type BridgeTaskFacts } from "./same-session-bridge.ts";
import { AttachmentStore } from "../../piagent-core/runtime/input/attachment-store.ts";
import { HeldMessageQueue } from "./held-message-queue.ts";
import { LifecycleController } from "./lifecycle-controller.ts";
import { lifecycleRuntimeDraft } from "./lifecycle-event-adapter.ts";
import { PiSessionStreamAdapter } from "./session-stream-adapter.ts";
import { SessionOptionsController } from "./session-options-controller.ts";
import { ReviewController } from "./review-controller.ts";
import { SourceMutationController } from "./source-mutation-controller.ts";
import { SourceRevertController } from "./source-revert-controller.ts";
import { SourceOpenController } from "./source-open-controller.ts";
import { VSCodeHandoff } from "./vscode-handoff.ts";
import { TerminalSessionAdapter } from "./terminal-session-adapter.ts";
import { isGatewayRuntimeContext } from "../ownership/gateway-runtime-context.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const SOURCE_VIEWS = new Set<SourceView>(["task", "working-tree", "staged"]);
type Manager = {
  key: string;
  ctx: ExtensionContext;
  child: ChildProcess;
  provider: CoreInspectionProvider;
  eventReader: EventReader;
  lastCursor: string;
  descriptor: string;
  controlDirectory: string;
  controlSocket: string;
  origin: string;
};

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function createWebUiExtensionRuntimeInstanceRef(): string { return `runtime.${hash(randomBytes(32).toString("hex"))}`; }
function key(ctx: ExtensionContext): string { return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`; }
function sessionRef(ctx: ExtensionContext): string { return webUiSessionRef(ctx.sessionManager.getSessionId()); }
function descriptorDirectory(cwd: string): string { return path.join(cwd, ".pi", "piagent-state", "webui-launcher"); }
function descriptorPath(ctx: ExtensionContext): string { return path.join(descriptorDirectory(ctx.cwd), `${hash(sessionRef(ctx))}.json`); }

class EventReader {
  readonly #store: RuntimeEventStore;
  constructor(ctx: ExtensionContext, runtimeInstanceId: string) {
    this.#store = new RuntimeEventStore({ projectRoot: ctx.cwd, projectRef: webUiProjectRef(ctx.cwd),
      runtimeInstanceId, sessionRef: sessionRef(ctx) });
  }
  retention(): unknown { return this.#store.retention(); }
  currentCursor(): string { return this.#store.currentCursor(); }
  resyncRequired(): boolean { return this.#store.resyncRequired(); }
  replay(after: string | null, limit: number) { return this.#store.replay(after, limit); }
  append(draft: RuntimeEventDraft) { return this.#store.append(draft); }
}

function protectedPaths(ctx: ExtensionContext): string[] {
  try {
    const resolved = loadProjectContextIndexPolicy(PLATFORM_ROOT, ctx.cwd);
    return effectiveProtectedPaths(resolved.policy, resolved.profile).readProtectedPaths;
  } catch { return [".pi/piagent-state/**", ".pi/context-index.json"]; }
}

// The same profile grant `piagent_document_read` honours. Read from the profile
// on every call rather than captured once, so an operator who adds a directory
// mid-session sees it in the workspace without restarting Pi.
function documentReadRoots(ctx: ExtensionContext): unknown {
  try { return loadProjectContextIndexPolicy(PLATFORM_ROOT, ctx.cwd).profile.additionalReadRoots; }
  catch { return []; }
}

function writeDescriptor(ctx: ExtensionContext, value: Record<string, unknown>): string {
  const directory = ensurePrivateStateDirectory(ctx.cwd, descriptorDirectory(ctx.cwd), "WebUI launcher directory");
  const target = resolveLocalStatePath(ctx.cwd, descriptorPath(ctx), { label: "WebUI launcher descriptor" });
  try {
    const existing = fs.lstatSync(target);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("WebUI launcher descriptor is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.descriptor-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); fs.fchmodSync(descriptor, 0o600); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, target);
  return target;
}

function removeDescriptor(cwd: string, target: string): void {
  try {
    const verified = resolveLocalStatePath(cwd, target, { label: "WebUI launcher descriptor", kind: "file" });
    fs.unlinkSync(verified);
  } catch { /* already absent or unsafe: never broaden the delete target */ }
}

function removeControlDirectory(directory: string): void {
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("piagent-webui-")) return;
  try {
    for (const entry of fs.readdirSync(directory)) {
      if (entry !== "control.sock") return;
      const socket = path.join(directory, entry), stat = fs.lstatSync(socket);
      if (!stat.isSocket()) return;
      fs.unlinkSync(socket);
    }
    fs.rmdirSync(directory);
  } catch { /* the sidecar may already have removed its private socket directory */ }
}

function openLocalUrl(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return false;
  try { const child = spawn(command, [url], { detached: true, stdio: "ignore" }); child.unref(); return true; }
  catch { return false; }
}

function readMethod(provider: CoreInspectionProvider, queue: HeldMessageQueue, sessionOptions: SessionOptionsController, lifecycle: LifecycleController,
  review: ReviewController, sourceMutation: SourceMutationController, sourceRevert: SourceRevertController, attachments: AttachmentStore | null,
  sourceOpen: SourceOpenController,
  approvalDecision: (approvalRef: string, decision: unknown) => Promise<unknown>,
  method: string, args: unknown[]): Promise<unknown> {
  if (method === "snapshot" && args.length === 0) return provider.snapshot();
  if (method === "capabilities" && args.length === 0) return provider.snapshot().then((value: any) => value.capabilities);
  if (method === "activity" && args.length === 0) return provider.activity();
  if (method === "sourceChanges" && args.length === 1 && SOURCE_VIEWS.has(args[0] as SourceView)) return provider.sourceChanges(args[0] as SourceView);
  if (method === "diff" && args.length === 2 && SOURCE_VIEWS.has(args[0] as SourceView) && typeof args[1] === "string" && REF.test(args[1])) return provider.diff(args[0] as SourceView, args[1]);
  if (method === "review" && args.length === 2 && SOURCE_VIEWS.has(args[0] as SourceView) && typeof args[1] === "string" && REF.test(args[1])) return provider.review(args[0] as SourceView, args[1]);
  if (method === "sourceMutation" && args.length === 2 && ["source.stage", "source.unstage"].includes(String(args[0]))
    && typeof args[1] === "string" && REF.test(args[1])) return provider.sourceMutation(args[0] as "source.stage" | "source.unstage", args[1]);
  if (method === "sourceRevert" && args.length === 2 && typeof args[0] === "string" && REF.test(args[0])
    && (args[1] === null || typeof args[1] === "string" && REF.test(args[1]))) return provider.sourceRevert(args[0], args[1] as string | null);
  if (method === "commitSummary" && args.length === 0) return provider.commitSummary();
  if (method === "taskIndex" && args.length === 0) return provider.taskIndex();
  if (method === "taskTimeline" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.taskTimeline(args[0]);
  if (method === "recoveryHistory" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.recoveryHistory(args[0]);
  if (method === "handoffHistory" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.handoffHistory(args[0]);
  if (method === "subagentTree" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.subagentTree(args[0]);
  if (method === "releaseMonitor" && args.length === 0) return provider.releaseMonitor();
  if (method === "documents" && args.length === 0) return provider.documents();
  if (method === "document" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.document(args[0]);
  if (method === "logPreview" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.logPreview(args[0]);
  if (method === "transcript" && args.length === 2 && (args[0] === null || typeof args[0] === "string" && REF.test(args[0]))
    && Number.isInteger(args[1]) && Number(args[1]) >= 1 && Number(args[1]) <= 200) return provider.transcript(args[0] as string | null, Number(args[1]));
  if (method === "queue" && args.length === 0) return provider.queue();
  if (method === "modelCatalog" && args.length === 0) return provider.modelCatalog();
  if (method === "approval" && args.length === 1 && typeof args[0] === "string" && REF.test(args[0])) return provider.approval(args[0]);
  if (method === "approvalDecision" && args.length === 2 && typeof args[0] === "string" && REF.test(args[0])
    && args[1] && typeof args[1] === "object") return approvalDecision(args[0], args[1]);
  if (method === "attachment" && args.length === 1 && args[0] && typeof args[0] === "object" && attachments) return Promise.resolve(attachments.execute(args[0]));
  if (method === "replay" && args.length === 2 && (args[0] === null || typeof args[0] === "string" && REF.test(args[0]))
    && Number.isInteger(args[1]) && Number(args[1]) >= 1 && Number(args[1]) <= 10_000) return Promise.resolve(provider.replay(args[0] as string | null, Number(args[1])));
  if (method === "control" && args.length === 1 && args[0] && typeof args[0] === "object") {
    const action = (args[0] as Record<string, unknown>).action;
    const execute = action === "review.mark" ? review.execute(args[0])
      : action === "source.stage" || action === "source.unstage" ? sourceMutation.execute(args[0])
      : action === "source.revert" ? sourceRevert.execute(args[0])
      : action === "source.open-in-vscode" ? sourceOpen.execute(args[0])
      : typeof action === "string" && action.startsWith("lifecycle.") ? lifecycle.execute(args[0])
      : action === "session-options.set-model" || action === "session-options.set-thinking" ? sessionOptions.execute(args[0]) : queue.execute(args[0]);
    return execute.then((receipt) => { provider.invalidate(); return receipt; });
  }
  return Promise.reject(new Error("webui-read-request-invalid"));
}

export default function piagentWebUiExtension(pi: ExtensionAPI): void {
  const runtimeInstanceId = createWebUiExtensionRuntimeInstanceRef();
  let terminalAdapter: TerminalSessionAdapter | null = null;
  const managers = new Map<string, Manager>();
  const eventReaders = new Map<string, EventReader>();
  const taskFacts = (ctx: ExtensionContext): BridgeTaskFacts => {
    const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId());
    if (!task) return null;
    const taskRevision = webUiTaskRevision(task), control = inspectTaskControlState(ctx.cwd, task);
    return { taskId: task.taskId, taskRunId: task.taskRunId, taskRevision, controlState: control.state,
      controlRevision: control.controlRevision };
  };
  let currentContext: ExtensionContext | null = null, attachments: AttachmentStore | null = null;
  let approvalBinding: { key: string; unbind(): void; unsubscribe(): void } | null = null;
  const bridge = new SameSessionPiBridge(pi, { runtimeInstanceId, taskFacts,
    prepareAttachments: (refs, request, identity, text) => {
      if (!attachments) throw new Error("attachment-store-unavailable");
      const reservation = attachments.reserve(refs, request, identity, text);
      return { ...reservation.prepared, commit: reservation.commit, release: reservation.release };
    } });
  try { attachments = new AttachmentStore({ runtimeInstanceId, bridgeSnapshot: () => bridge.snapshot(),
    modelSupportsImages: () => Array.isArray(currentContext?.model?.input) && currentContext.model.input.includes("image") }); }
  catch { attachments = null; }
  const queue = new HeldMessageQueue({ bridge, appendEntry: (customType, data) => pi.appendEntry(customType, data) });
  const sessionOptions = new SessionOptionsController({ pi, bridge });
  const vscode = new VSCodeHandoff();
  const lifecycle = new LifecycleController({ bridge, runtimeInstanceId,
    task: (ctx) => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()), abort: (ctx) => ctx.abort(),
    cancelApprovals: (ctx, taskRunId) => { piApprovalBroker.cancelForControl(ctx.cwd, ctx.sessionManager.getSessionId(), taskRunId); },
    treeDigest: (ctx) => { const snapshot = workingTreeSnapshot(ctx.cwd); return workingTreeSnapshotHasUnavailableEvidence(snapshot)
      ? null : workingTreeEvidenceDigest(snapshot as Record<string, string>); } });
  const stream = new PiSessionStreamAdapter();
  const bridgeSoft = (action: () => void): void => { try { action(); } catch { /* bridge failure never affects the Pi session */ } };

  function approvalAuthority(): ApprovalAuthority {
    const snapshot = bridge.snapshot(), identity = snapshot.identity, revisions = snapshot.revisions;
    if (snapshot.state !== "ready" || !identity || !revisions || !identity.taskId || !identity.taskRunId || !identity.agentOperationId
      || !["active", "terminal"].includes(snapshot.taskState)
      || !revisions.taskRevision || !revisions.controlRevision) return null;
    return { identity: { projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef,
      taskId: identity.taskId, taskRunId: identity.taskRunId, agentOperationId: identity.agentOperationId },
      revisions: { runtimeRevision: revisions.runtimeRevision, taskRevision: revisions.taskRevision, controlRevision: revisions.controlRevision },
      taskState: snapshot.taskState === "terminal" ? "terminal" : "active" };
  }

  function approvalDraft(event: ApprovalBrokerEvent): RuntimeEventDraft | null {
    const snapshot = bridge.snapshot(), identity = snapshot.identity, revisions = snapshot.revisions;
    const request = event.request as any, receipt = event.receipt as any, record = request ?? receipt;
    if (!identity?.agentOperationId || !identity.taskId || !identity.taskRunId || !revisions || !record?.identity?.toolCallId) return null;
    const approval = currentContext ? piApprovalBroker.projection(currentContext.cwd, currentContext.sessionManager.getSessionId()) : null;
    const expired = event.kind === "expired", requested = event.kind === "requested";
    const action = request?.action, resolution = receipt?.decision ?? (receipt?.state === "cancelled" ? "cancel" : expired ? "deny" : null);
    const actionSummary = request ? `${String(action.toolName)}: ${String(action.reason)}` : `${String(record.identity.toolCallId)}: ${String(resolution ?? receipt?.state)}`;
    return { sourceObservedAt: requested ? request.requestedAt : receipt.resolvedAt, projectRef: identity.projectRef,
      runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId,
      agentOperationId: identity.agentOperationId, turnIndex: null, messageRef: null, toolCallId: record.identity.toolCallId,
      revision: { ...revisions, approvalRevision: approval?.revision ?? null }, kind: requested ? "approval.requested" : expired ? "approval.expired" : "approval.resolved",
      correlation: { commandId: null, messageRequestId: null, replacementId: null, approvalRequestId: event.approvalRef,
        causationEventId: null, idempotencyKeyDigest: null }, evidence: "observed",
      payload: { state: requested ? "requested" : expired ? "expired" : "resolved", actionDigest: requested ? action.actionDigest : receipt.actionDigest,
        actionSummary: actionSummary.slice(0, 500), decision: resolution, expiresAt: requested ? request.expiresAt : null,
        resolutionCode: requested ? null : String(receipt.resolutionReason ?? receipt.winnerSurface ?? "approval-resolved") },
      redaction: requested ? structuredClone(action.redaction) : { applied: false, valuesRemoved: 0, truncated: false } };
  }

  function bindApproval(ctx: ExtensionContext): void {
    const bindingKey = key(ctx);
    if (approvalBinding && approvalBinding.key !== bindingKey) { approvalBinding.unsubscribe(); approvalBinding.unbind(); approvalBinding = null; }
    const unbind = piApprovalBroker.bind({ cwd: ctx.cwd, rawSessionId: ctx.sessionManager.getSessionId(), runtimeInstanceId, authority: approvalAuthority });
    if (approvalBinding) { approvalBinding.unbind = unbind; return; }
    const unsubscribe = piApprovalBroker.subscribe(ctx.cwd, ctx.sessionManager.getSessionId(), (event) => {
      const draft = approvalDraft(event); if (draft) publishDrafts(ctx, [draft]); currentManager(ctx)?.provider.invalidate();
    });
    approvalBinding = { key: bindingKey, unbind, unsubscribe };
  }

  function eventReader(ctx: ExtensionContext): EventReader {
    const readerKey = key(ctx), existing = eventReaders.get(readerKey);
    if (existing) return existing;
    const reader = new EventReader(ctx, runtimeInstanceId); eventReaders.set(readerKey, reader); return reader;
  }
  lifecycle.subscribe((event) => { const draft = lifecycleRuntimeDraft(event, bridge.snapshot()); if (draft && currentContext) publishDrafts(currentContext, [draft]);
    if (currentContext) currentManager(currentContext)?.provider.invalidate(); });
  function publishDrafts(ctx: ExtensionContext, drafts: RuntimeEventDraft[]): void {
    if (!drafts.length) return;
    try {
      const reader = eventReader(ctx), manager = currentManager(ctx);
      for (const draft of drafts) {
        const result = reader.append(draft);
        if (result.appended) manager?.provider.publishObserved(result.event);
      }
      if (manager) manager.lastCursor = reader.currentCursor();
    } catch { /* streaming projection is best-effort and never blocks Pi */ }
  }

  function currentManager(ctx: ExtensionContext): Manager | undefined {
    const manager = managers.get(key(ctx));
    if (manager && manager.child.exitCode === null && !manager.child.killed) { manager.ctx = ctx; return manager; }
    if (manager) managers.delete(manager.key);
    return undefined;
  }

  function publishPersisted(ctx: ExtensionContext): void {
    const manager = currentManager(ctx);
    if (!manager) return;
    setTimeout(() => {
      try {
        const replay = manager.eventReader.replay(manager.lastCursor, 100);
        if (replay.state !== "current") return;
        for (const event of replay.events) manager.provider.publishObserved(event);
        manager.lastCursor = replay.nextCursor;
      } catch { /* a projection failure never affects the Pi agent loop */ }
    }, 0).unref();
  }

  async function stopManager(manager: Manager): Promise<void> {
    managers.delete(manager.key);
    removeDescriptor(manager.ctx.cwd, manager.descriptor);
    if (manager.child.exitCode === null && !manager.child.killed) manager.child.kill("SIGTERM");
  }

  async function start(ctx: ExtensionContext, openBrowser: boolean): Promise<Manager> {
    const existing = currentManager(ctx);
    if (existing) {
      ctx.ui.notify(`Piagent WebUI is already running at ${existing.origin}`, "info");
      return existing;
    }
    const staticRoot = path.join(PACKAGE_ROOT, "dist", "client");
    if (!fs.existsSync(path.join(staticRoot, "index.html"))) throw new Error("WebUI static build is missing; run npm run build --workspace @piagent/webui");
    const reader = eventReader(ctx);
    const provider = new CoreInspectionProvider({
      cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), runtimeInstanceId, eventStore: reader,
      task: () => activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()),
      activityEvents: () => readContextTelemetry(ctx.cwd, { limit: 5_000 }) as unknown[],
      currentActivity: () => [], sessionEntries: () => ctx.sessionManager.getBranch(), protectedPaths: () => protectedPaths(ctx),
      documentReadRoots: () => documentReadRoots(ctx),
      contextUsage: () => ctx.getContextUsage(), model: () => ctx.model,
      thinkingLevel: () => ctx.thinkingLevel ?? pi.getThinkingLevel(),
      queueProjection: () => queue.projection(),
      modelCatalog: () => sessionOptions.catalog(),
      attachmentCapability: attachments ? () => attachments!.capability() : undefined,
      approvalProjection: () => piApprovalBroker.projection(ctx.cwd, ctx.sessionManager.getSessionId()),
      approvalDetail: (approvalRef) => piApprovalBroker.detail(ctx.cwd, ctx.sessionManager.getSessionId(), approvalRef),
      sourceMutationGuardAvailable: () => piSourceMutationGuard.available(ctx.cwd, ctx.sessionManager.getSessionId()),
      sourceOpenAvailable: () => vscode.available(),
      lifecycleControl: () => lifecycle.snapshot(),
      chatControl: () => { const snapshot = bridge.snapshot(), held = queue.snapshot(); return { ...snapshot, heldCount: held.heldCount,
        queueRevision: held.queueRevision }; }
    });
    const review = new ReviewController({ bridge, projectRoot: ctx.cwd,
      resolve: (view, fileRef) => provider.review(view, fileRef) as Promise<import("../../piagent-core/runtime/inspection/review-state-projection.ts").ReviewStateProjection> });
    const sourceMutation = new SourceMutationController({ bridge, projectRoot: ctx.cwd,
      resolve: (action, fileRef) => provider.sourceMutationAuthority(action, fileRef), revisions: () => provider.canonicalRevisions(),
      mutate: (input) => piSourceMutationGuard.execute({ cwd: ctx.cwd, rawSessionId: ctx.sessionManager.getSessionId(), ...input }) });
    const sourceRevert = new SourceRevertController({ bridge, projectRoot: ctx.cwd,
      resolve: (fileRef, hunkRefs) => provider.sourceRevertAuthority(fileRef, hunkRefs), revisions: () => provider.canonicalRevisions(),
      mutate: (input) => piSourceMutationGuard.executeRevert({ cwd: ctx.cwd, rawSessionId: ctx.sessionManager.getSessionId(), ...input }) });
    const sourceOpen = new SourceOpenController({ bridge, projectRoot: ctx.cwd, resolve: (fileRef) => provider.sourceOpenAuthority(fileRef),
      open: (absolutePath, line, column) => vscode.open(absolutePath, line, column) });
    const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-"));
    fs.chmodSync(socketDirectory, 0o700);
    const socket = path.join(socketDirectory, "control.sock");
    const controlToken = randomBytes(32).toString("base64url");
    const loader = path.join(PLATFORM_ROOT, "scripts", "register-typescript-loader.mjs");
    const main = path.join(PACKAGE_ROOT, "server", "sidecar-main.ts");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", loader, main], {
      cwd: ctx.cwd, env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? os.tmpdir(), NO_COLOR: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let diagnostics = "";
    child.stderr?.on("data", (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-4_096); });
    let ready: { origin: string; launchUrl: string };
    try {
      ready = await new Promise<{ origin: string; launchUrl: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebUI sidecar start timed out")), 30_000); timer.unref();
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`WebUI sidecar exited (${code ?? "unknown"}): ${diagnostics.replace(/\s+/g, " ").slice(0, 300)}`)));
        child.on("message", (message: any) => {
          if (message?.channel !== "piagent-webui") return;
          if (message.type === "ready" && typeof message.origin === "string" && typeof message.launchUrl === "string") {
            clearTimeout(timer); resolve({ origin: message.origin, launchUrl: message.launchUrl });
          } else if (message.type === "fatal") { clearTimeout(timer); reject(new Error("WebUI sidecar could not start")); }
        });
        child.send({ channel: "piagent-webui", type: "init", staticRoot, controlSocket: socket, controlToken });
      });
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      removeControlDirectory(socketDirectory);
      throw error;
    }
    const manager = { key: key(ctx), ctx, child, provider, eventReader: reader, lastCursor: reader.currentCursor(),
      descriptor: "", controlDirectory: socketDirectory, controlSocket: socket, origin: ready.origin } satisfies Manager;
    manager.descriptor = writeDescriptor(ctx, { schemaVersion: 1, projectRef: webUiProjectRef(ctx.cwd), sessionRef: sessionRef(ctx),
      runtimeInstanceId, origin: ready.origin, controlSocket: socket, controlToken, sidecarPid: child.pid, createdAt: new Date().toISOString() });
    managers.set(manager.key, manager);
    const unsubscribe = provider.subscribe((event) => child.connected && child.send?.({ channel: "piagent-webui", type: "event", event }));
    child.on("message", (message: any) => {
      if (message?.channel !== "piagent-webui" || message.type !== "request" || typeof message.requestId !== "string"
        || typeof message.method !== "string" || !Array.isArray(message.args)) return;
      void readMethod(provider, queue, sessionOptions, lifecycle, review, sourceMutation, sourceRevert, attachments, sourceOpen,
        (approvalRef, decision) => piApprovalBroker.decide(ctx.cwd, ctx.sessionManager.getSessionId(), approvalRef, decision),
        message.method, message.args).then(
        (value) => child.connected && child.send?.({ channel: "piagent-webui", type: "response", requestId: message.requestId, ok: true, value }),
        (error) => child.connected && child.send?.({ channel: "piagent-webui", type: "response", requestId: message.requestId, ok: false,
          error: message.method === "approvalDecision" && error instanceof Error && /^approval-[a-z-]+$/.test(error.message) ? error.message : "read-model-unavailable" })
      );
    });
    child.once("exit", () => { unsubscribe(); managers.delete(manager.key); removeDescriptor(ctx.cwd, manager.descriptor);
      removeControlDirectory(manager.controlDirectory); });
    if (openBrowser && !openLocalUrl(ready.launchUrl)) ctx.ui.notify(`Open this local URL: ${ready.launchUrl}`, "info");
    ctx.ui.notify(`Piagent WebUI is ready at ${ready.origin}`, "info");
    return manager;
  }

  pi.registerCommand("piagent-webui", {
    description: "Open the local read-only Piagent WebUI for this exact session",
    handler: async (raw: string, ctx: ExtensionContext) => {
      const action = String(raw ?? "").trim().toLowerCase() || "open";
      if (action === "stop") {
        const manager = currentManager(ctx);
        if (!manager) { ctx.ui.notify("Piagent WebUI is not running for this session.", "info"); return; }
        await stopManager(manager); ctx.ui.notify("Piagent WebUI stopped. The Pi session is unchanged.", "info"); return;
      }
      if (action === "status") {
        const manager = currentManager(ctx);
        ctx.ui.notify(manager ? `Piagent WebUI is running at ${manager.origin}` : "Piagent WebUI is not running for this session.", "info"); return;
      }
      if (!['open', '--no-open'].includes(action)) { ctx.ui.notify("Usage: /piagent-webui [open|--no-open|status|stop]", "warning"); return; }
      try { await start(ctx, action !== "--no-open"); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Piagent WebUI could not start", "error"); }
    }
  });

  pi.on("tool_call", (event, ctx) => { publishPersisted(ctx); if (!isGatewayRuntimeContext(ctx) && !terminalAdapter?.dispatchAllowed(ctx)) return { block: true,
    reason: `Piagent cannot prove this terminal owns the session (${terminalAdapter?.reasonCode() ?? "terminal-session-adapter-unavailable"}).` };
    if (!lifecycle.toolAllowed(String(event.toolName ?? ""), ctx)) return { block: true,
    reason: "Piagent lifecycle control blocks tool work while the task is paused, stopping, or terminal. A terminal task may only start its successor." }; });
  pi.on("tool_result", (_event, ctx) => publishPersisted(ctx));
  pi.on("input", (event, ctx) => {
    if (!isGatewayRuntimeContext(ctx) && !terminalAdapter?.dispatchAllowed(ctx)) {
      try { ctx.ui.notify(`Piagent cannot prove this terminal owns the session (${terminalAdapter?.reasonCode() ?? "terminal-session-adapter-unavailable"}).`, "error"); }
      catch { /* optional UI */ }
      return { action: "handled" } as const;
    }
    if (!lifecycle.inputAllowed(ctx)) {
      try { ctx.ui.notify("Piagent task is paused or stopping. Resume it before sending new work.", "warning"); } catch { /* optional UI */ }
      return { action: "handled" } as const;
    }
    if (bridge.sessionOptionMutationActive(ctx)) {
      try { ctx.ui.notify("Piagent WebUI is finishing a model/thinking change; retry this input after it settles.", "warning"); } catch { /* optional UI */ }
      return { action: "handled" } as const;
    }
    bridgeSoft(() => bridge.observeInput(event, ctx)); return undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    bridgeSoft(() => bridge.observeAgentStart(ctx)); bridgeSoft(() => lifecycle.observeAgentStart(ctx)); publishDrafts(ctx, stream.agentStarted(bridge.snapshot()));
  });
  pi.on("turn_start", (event, ctx) => publishDrafts(ctx, stream.turnStarted(event, bridge.snapshot())));
  pi.on("message_start", (event, ctx) => {
    bridgeSoft(() => bridge.observeMessageStart(event, ctx)); publishDrafts(ctx, stream.messageStarted(event, bridge.snapshot()));
  });
  pi.on("message_update", (event, ctx) => publishDrafts(ctx, stream.messageUpdated(event, bridge.snapshot())));
  pi.on("message_end", (event, ctx) => publishDrafts(ctx, stream.messageEnded(event, bridge.snapshot())));
  pi.on("tool_execution_start", (event, ctx) => { bridgeSoft(() => lifecycle.observeToolStart(ctx)); publishDrafts(ctx, stream.toolStarted(event, bridge.snapshot())); });
  pi.on("tool_execution_update", (event, ctx) => publishDrafts(ctx, stream.toolUpdated(event, bridge.snapshot())));
  pi.on("tool_execution_end", (event, ctx) => { publishDrafts(ctx, stream.toolEnded(event, bridge.snapshot())); bridgeSoft(() => lifecycle.observeToolEnd(ctx)); });
  pi.on("turn_end", (event, ctx) => publishDrafts(ctx, stream.turnEnded(event, bridge.snapshot())));
  pi.on("agent_settled", (_event, ctx) => {
    publishDrafts(ctx, stream.agentSettled(bridge.snapshot(), typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : null));
    const operationId = bridge.snapshot().identity?.agentOperationId ?? null;
    bridgeSoft(() => bridge.observeAgentSettled(ctx)); bridgeSoft(() => lifecycle.observeAgentSettled(ctx, operationId)); publishPersisted(ctx);
  });
  pi.on("session_info_changed", (_event, ctx) => { currentContext = ctx; bridgeSoft(() => bridge.refresh(ctx)); });
  pi.on("model_select", (_event, ctx) => { currentContext = ctx; bridgeSoft(() => sessionOptions.observeHostOptionChange(ctx)); currentManager(ctx)?.provider.invalidate(); });
  pi.on("thinking_level_select", (_event, ctx) => { currentContext = ctx; bridgeSoft(() => sessionOptions.observeHostOptionChange(ctx)); currentManager(ctx)?.provider.invalidate(); });
  pi.on("session_before_switch", () => { lifecycle.replacementPending(); bridgeSoft(() => bridge.replacementPending()); });
  pi.on("session_before_fork", () => { lifecycle.replacementPending(); bridgeSoft(() => bridge.replacementPending()); });
  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx; stream.reset(); queue.reset(); sessionOptions.reset(); attachments?.reset();
    if (!isGatewayRuntimeContext(ctx)) {
      try { terminalAdapter ??= new TerminalSessionAdapter(runtimeInstanceId); } catch { terminalAdapter = null; }
      try { terminalAdapter?.bind(ctx); }
      catch (error) { try { ctx.ui.notify(error instanceof Error ? error.message : "terminal-session-lease-unavailable", "error"); } catch { /* optional UI */ } }
    }
    bridgeSoft(() => bridge.bind(ctx));
    bridgeSoft(() => lifecycle.bind(ctx));
    bridgeSoft(() => bindApproval(ctx));
    bridgeSoft(() => sessionOptions.bind(ctx));
    if (String(process.env.PIAGENT_WEBUI_AUTOSTART ?? "").toLowerCase() !== "1") return;
    try { await start(ctx, false); }
    catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Piagent WebUI could not start", "error"); }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stream.reset(); queue.reset(); sessionOptions.reset(); attachments?.close(); eventReaders.delete(key(ctx));
    if (approvalBinding?.key === key(ctx)) { approvalBinding.unsubscribe(); approvalBinding.unbind(); approvalBinding = null; }
    lifecycle.shutdown();
    bridgeSoft(() => bridge.shutdown(ctx));
    terminalAdapter?.release();
    const manager = currentManager(ctx);
    if (manager) await stopManager(manager);
    currentContext = null;
  });
}
