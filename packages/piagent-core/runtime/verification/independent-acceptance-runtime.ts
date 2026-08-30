import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";
import type { AuthenticatedAssessment } from "../../extensions/acceptance-authenticated-admission.js";
import { openHostContractConfiguration } from "../../extensions/acceptance-host-configuration.js";
import { registerIndependentAcceptanceProvider } from "../../extensions/acceptance-independent-registry.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import { createRuntimeContractRunner } from "./runtime-contract-runner.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";

type Options = { state: RuntimeSessionState; installedRoot: string; configPath?: string;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  authorizeSourceRead: (ctx: ExtensionContext, sourcePath: string) => boolean };
type Entry = { configuration?: ReturnType<typeof openHostContractConfiguration>; dispose: () => void;
  block?: string; runners: Array<{ contract: any; runner: ReturnType<typeof createRuntimeContractRunner>; receipt?: AuthenticatedAssessment }>; pending?: Promise<void> };

/** Approved host configuration is opt-in; there is no model-authored oracle. */
export class IndependentAcceptanceRuntime {
  readonly #options: Options;
  readonly #entries = new Map<string, Entry>();
  constructor(options: Options) { this.#options = options; }
  #key(ctx: ExtensionContext, task: TaskContract) { return `${ctx.cwd}\0${task.sessionId}\0${task.taskRunId}`; }

  async prepare(ctx: ExtensionContext, task: TaskContract): Promise<void> {
    const options = this.#options;
    if (!options.configPath || task.trace.outcome !== "pending") return;
    const key = this.#key(ctx, task);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { dispose: () => {}, runners: [] };
      const owned = entry;
      owned.dispose = registerIndependentAcceptanceProvider(ctx.cwd, task, (_projected: TaskContract, digest: string) => {
        if (owned.block) return { block: owned.block };
        if (!owned.configuration?.isCurrent()) return { block: "independent host approval or installed verifier changed" };
        const active = options.activeTask(ctx), snapshot = captureWorkspaceVerificationSnapshot(ctx.cwd);
        const projectVerificationDigest = active && snapshot.digest === digest
          ? options.state.projectVerification.currentDigest(ctx, active, snapshot, undefined, { completedProjection: true }) : null;
        return { entries: owned.runners.map((item) => ({ ...item.contract, receipt: item.receipt })), projectVerificationDigest };
      });
      this.#entries.set(key, owned);
      while (this.#entries.size > 100) {
        const oldest = this.#entries.keys().next().value as string, removed = this.#entries.get(oldest)!;
        removed.dispose(); removed.configuration?.close(); this.#entries.delete(oldest);
      }
      try {
        const configuration = openHostContractConfiguration({ configPath: options.configPath, projectRoot: ctx.cwd, installedRoot: options.installedRoot });
        owned.configuration = configuration;
        if (configuration.payload.operatorRequestDigest !== task.operatorRequestDigest) return;
        for (const contract of configuration.payload.contracts) {
          if (!task.acceptanceReceipt?.criteria.some((criterion) => criterion.id === contract.criterionId && criterion.hash === contract.criterionHash)) {
            throw new Error("Approved criterion mismatch");
          }
          const runner = createRuntimeContractRunner({ state: options.state, context: ctx, getTask: () => options.activeTask(ctx),
            approved: { store: configuration.store, sourcePath: contract.sourcePath, exportName: contract.exportName, checks: contract.checks,
              ...configuration.payload.backend, verifierDigest: configuration.payload.verifierDigest,
              authorizeSourceRead: ({ sourcePath }) => (sourcePath !== contract.sourcePath || configuration.isCurrent()) && options.authorizeSourceRead(ctx, sourcePath) } });
          owned.runners.push({ contract, runner });
        }
      } catch { owned.block = "independent host approval is unavailable or does not match the task"; }
    }
    if (entry.block || !entry.configuration?.isCurrent()) return;
    if (entry.pending) return entry.pending;
    const owned = entry;
    const pending = (async () => {
      for (const item of owned.runners) {
        try {
          const result = await item.runner.run({ scope: { taskRunId: task.taskRunId, criterionId: item.contract.criterionId },
            criterionHash: item.contract.criterionHash, maxAttempts: item.contract.maxAttempts });
          item.receipt = await item.runner.assess(result, { policy: "allow" });
        } catch { item.receipt = undefined; }
      }
    })();
    owned.pending = pending;
    try { await pending; } finally { if (owned.pending === pending) owned.pending = undefined; }
  }

  clear(ctx: ExtensionContext): void {
    const prefix = `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}\0`;
    for (const [key, entry] of this.#entries) if (key.startsWith(prefix)) {
      entry.dispose(); entry.configuration?.close(); this.#entries.delete(key);
    }
  }
}
