import type { SourceRevertProjection } from "../../piagent-core/runtime/inspection/source-action-contract.ts";
import { piSourceMutationGuard } from "../../piagent-core/runtime/policy/source-mutation-guard.ts";
import type { BridgeSnapshot } from "../../piagent-core/runtime/inspection/session-identity.ts";
import { SourceRevertController } from "../server/source-revert-controller.ts";
import type { CoreInspectionProvider } from "../server/core-inspection-provider.ts";
import { SourceRevertStore } from "./source-revert-store.ts";
import { sessionRefForPath } from "./session-catalog.ts";
import type { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";

type Options = { root: string; key: Buffer; managed: boolean;
  runtimes: Pick<SessionRuntimeSupervisor, "listSessions" | "acquire" | "liveSessionManager" | "currentOperation">;
  provider(sessionRef: string): Promise<CoreInspectionProvider>; changed(sessionRef: string): void };

// The catalog ref selects a runtime. The inspection identity inside commands
// remains independently bound to that runtime; the two refs need not be equal.
export class SourceRevertSessions {
  readonly #options: Options; readonly #store: SourceRevertStore;
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(options: Options) { this.#options = options; this.#store = new SourceRevertStore(options.root, options.key); }
  #serial<T>(sessionRef: string, action: () => Promise<T>): Promise<T> {
    const run = (this.#pending.get(sessionRef) ?? Promise.resolve()).then(action, action);
    this.#pending.set(sessionRef, run);
    void run.finally(() => { if (this.#pending.get(sessionRef) === run) this.#pending.delete(sessionRef); }).catch(() => {});
    return run;
  }
  async #live(sessionRef: string) {
    const { runtimes, key } = this.#options;
    if (this.#options.managed) throw new Error("source-company-boundary-required");
    const matches = (await runtimes.listSessions()).filter(info => sessionRefForPath(key, info.path) === sessionRef);
    if (matches.length !== 1) throw new Error("source-session-unavailable");
    const info = matches[0]; await runtimes.acquire(sessionRef);
    const manager = runtimes.liveSessionManager(sessionRef);
    if (!manager || manager.getSessionId() !== info.id) throw new Error("source-session-unavailable");
    if (manager.buildSessionContext().model?.provider === "agent_watch_managed") throw new Error("source-company-boundary-required");
    const provider = await this.#options.provider(sessionRef); provider.invalidate();
    const snapshot = await provider.snapshot() as { identity: NonNullable<BridgeSnapshot["identity"]>; revision: NonNullable<BridgeSnapshot["revisions"]> };
    if (snapshot.identity.taskId !== null || snapshot.identity.taskRunId !== null) throw new Error("source-session-binding-unavailable");
    const binding = (): BridgeSnapshot => {
      const current = runtimes.liveSessionManager(sessionRef), same = current === manager && current?.getSessionId() === info.id;
      return { state: same ? "ready" : "replacement-pending", identity: snapshot.identity,
        revisions: { ...snapshot.revision, controlRevision: piSourceMutationGuard.sessionControlRevision(info.cwd, info.id) },
        taskState: "none", liveness: same ? runtimes.currentOperation(sessionRef) ? "running" : "idle" : "unknown", eventSequence: 0 };
    };
    return { info, provider, snapshot, binding };
  }
  sources(sessionRef: string) {
    return this.#serial(sessionRef, async () => (await this.#live(sessionRef)).provider.sourceChanges("working-tree"));
  }
  diff(sessionRef: string, fileRef: string) {
    return this.#serial(sessionRef, async () => (await this.#live(sessionRef)).provider.diff("working-tree", fileRef));
  }
  preview(sessionRef: string, fileRef: string, hunkRef: string | null) {
    return this.#serial(sessionRef, async () => {
      const { provider } = await this.#live(sessionRef);
      const preview = await provider.sourceRevert(fileRef, hunkRef) as SourceRevertProjection;
      const snapshot = await provider.snapshot() as { revision: { runtimeRevision: string; controlRevision: string | null } };
      return { ...preview, ...(snapshot.revision.controlRevision ? { commandBinding: {
        runtimeRevision: snapshot.revision.runtimeRevision, controlRevision: snapshot.revision.controlRevision } } : {}) };
    });
  }
  execute(sessionRef: string, command: unknown) {
    return this.#serial(sessionRef, async () => {
      const { info, provider, snapshot, binding } = await this.#live(sessionRef);
      const controller = new SourceRevertController({ allowSessionReverts: true, projectRoot: info.cwd, bridge: { snapshot: binding },
        evidence: this.#store.forSession(info.cwd, snapshot.identity.projectRef, snapshot.identity.sessionRef),
        resolve: (file, hunks) => provider.sourceRevertAuthority(file, hunks),
        revisions: async () => { provider.invalidate(); return (await provider.snapshot() as typeof snapshot).revision; },
        mutate: request => piSourceMutationGuard.executeRevert({ cwd: info.cwd, rawSessionId: info.id, ...request }) });
      const receipt = await controller.execute(command);
      if (receipt.phase !== "rejected") { provider.invalidate(); this.#options.changed(sessionRef); }
      return receipt;
    });
  }
}
