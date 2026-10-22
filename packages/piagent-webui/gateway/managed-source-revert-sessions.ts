import { createHash } from "node:crypto";
import { webUiProjectRef, webUiSessionRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import type { BridgeSnapshot, BridgeRevisions } from "../../piagent-core/runtime/inspection/session-identity.ts";
import type { SourceChangeViews } from "../../piagent-core/runtime/inspection/source-change-projection.ts";
import { managedSourceRevertController, type ManagedSourcePort, type ManagedSourceRequest } from "./managed-source-revert-controller.ts";
import { SourceRevertStore } from "./source-revert-store.ts";
import { sessionRefForPath } from "./session-catalog.ts";
import { inspectionRuntimeRef } from "./session-inspection-registry.ts";
import type { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";

export type ManagedSourceRuntime = { controlRevision: string; current(): boolean; source: ManagedSourcePort };
type Options = { root: string; key: Buffer; gatewayInstanceRef: string;
  runtimes: Pick<SessionRuntimeSupervisor, "listSessions" | "acquire" | "liveSessionManager" | "currentOperation">;
  managedSource?(id: string): ManagedSourceRuntime; changed(sessionRef: string): void };

export class ManagedSourceRevertSessions {
  readonly #options: Options; readonly #store: SourceRevertStore;
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(options: Options) { this.#options = options; this.#store = new SourceRevertStore(options.root, options.key); }
  #serial<T>(sessionRef: string, action: () => Promise<T>): Promise<T> {
    const run = (this.#pending.get(sessionRef) ?? Promise.resolve()).then(action, action);
    this.#pending.set(sessionRef, run);
    void run.finally(() => { if (this.#pending.get(sessionRef) === run) this.#pending.delete(sessionRef); }).catch(() => {});
    return run;
  }
  async #controller(sessionRef: string) {
    const { runtimes, key, managedSource, gatewayInstanceRef } = this.#options;
    if (!managedSource) throw new Error("source-company-boundary-required");
    const matches = (await runtimes.listSessions()).filter(info => sessionRefForPath(key, info.path) === sessionRef);
    if (matches.length !== 1) throw new Error("source-session-unavailable");
    const info = matches[0]; await runtimes.acquire(sessionRef);
    const manager = runtimes.liveSessionManager(sessionRef), runtime = managedSource(info.id);
    if (!manager || manager.getSessionId() !== info.id || !runtime.current()) throw new Error("source-session-unavailable");
    const identity = { projectRef: webUiProjectRef(info.cwd), sessionRef: webUiSessionRef(info.id),
      runtimeInstanceId: inspectionRuntimeRef(gatewayInstanceRef, sessionRef), taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
    const binding = { identity, rawSessionId: info.id, controlRevision: runtime.controlRevision,
      current: () => runtimes.liveSessionManager(sessionRef) === manager && manager.getSessionId() === info.id && runtime.current(),
      idle: () => !runtimes.currentOperation(sessionRef) };
    const commandBinding = { controlRevision: binding.controlRevision,
      runtimeRevision: `source-runtime.${createHash("sha256").update(JSON.stringify([identity, binding.controlRevision])).digest("hex")}` };
    const revisions: BridgeRevisions = { ...commandBinding, taskRevision: null, workspaceRevision: null, indexRevision: null,
      approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    const snapshot = (): BridgeSnapshot => ({ state: binding.current() ? "ready" : "replacement-pending", identity, revisions,
      taskState: "none", liveness: binding.idle() ? "idle" : "running", eventSequence: 0 });
    const controller = managedSourceRevertController({ projectRoot: info.cwd, binding, snapshot, source: runtime.source,
      evidence: this.#store.forSession(info.cwd, identity.projectRef, identity.sessionRef), revisions: async () => {
        const views = await runtime.source({ kind: "sources" }, binding) as SourceChangeViews;
        return { ...revisions, workspaceRevision: views.workingTree.viewRevision, indexRevision: views.staged.viewRevision };
      } });
    return { controller, commandBinding, read: (request: ManagedSourceRequest) => runtime.source(request, binding) };
  }
  sources(sessionRef: string) {
    return this.#serial(sessionRef, async () => {
      const { read } = await this.#controller(sessionRef);
      return (await read({ kind: "sources" }) as SourceChangeViews).workingTree;
    });
  }
  diff(sessionRef: string, fileRef: string) {
    return this.#serial(sessionRef, async () => (await this.#controller(sessionRef)).read({ kind: "diff", fileRef }));
  }
  preview(sessionRef: string, fileRef: string, hunkRef: string | null) {
    return this.#serial(sessionRef, async () => {
      const { controller, commandBinding } = await this.#controller(sessionRef);
      return { ...await controller.preview(fileRef, hunkRef ? [hunkRef] : []), commandBinding };
    });
  }
  execute(sessionRef: string, command: unknown) {
    return this.#serial(sessionRef, async () => {
      const { controller } = await this.#controller(sessionRef), receipt = await controller.execute(command);
      if (receipt.phase !== "rejected") this.#options.changed(sessionRef);
      return receipt;
    });
  }
}
