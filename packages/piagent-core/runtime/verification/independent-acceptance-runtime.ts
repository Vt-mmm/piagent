import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";
import type { AuthenticatedAssessment } from "../../extensions/acceptance-authenticated-admission.js";
import { openHostContractConfiguration } from "../../extensions/acceptance-host-configuration.js";
import { registerIndependentAcceptanceProvider } from "../../extensions/acceptance-independent-registry.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import { createRuntimeContractRunner } from "./runtime-contract-runner.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";
import type { CompletionPreparation } from "./completion-preparation.ts";

type Options = { state: RuntimeSessionState; installedRoot: string; configPath?: string;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  authorizeSourceRead: (ctx: ExtensionContext, sourcePath: string) => boolean };
type Entry = { configuration?: ReturnType<typeof openHostContractConfiguration>; dispose: () => void;
  controller: AbortController; block?: string; stop?: { reason: string; attemptId?: string };
  runners: Array<{ contract: any; runner: ReturnType<typeof createRuntimeContractRunner>; receipt?: AuthenticatedAssessment }>; pending?: Promise<void> };

/** Approved host configuration is opt-in; there is no model-authored oracle. */
export class IndependentAcceptanceRuntime {
  readonly #options: Options;
  readonly #entries = new Map<string, Entry>();
  readonly #active = new Map<string, symbol>();
  readonly #retiring = new Map<string, Promise<void>>();
  constructor(options: Options) { this.#options = options; }
  #key(ctx: ExtensionContext, task: TaskContract) { return `${ctx.cwd}\0${task.sessionId}\0${task.taskRunId}`; }
  #session(ctx: ExtensionContext) { return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}\0`; }
  async activate(ctx: ExtensionContext): Promise<void> {
    const prefix = this.#session(ctx);
    while (this.#retiring.has(prefix)) await this.#retiring.get(prefix);
    if (this.#active.has(prefix)) return;
    this.#active.set(prefix, Symbol("session-lifetime"));
    while (this.#active.size > 100) await this.#retireSession(this.#active.keys().next().value as string);
  }
  async #retire(entry: Entry): Promise<void> {
    entry.block = "independent verification is stopping";
    entry.controller.abort();
    try { await entry.pending; } finally { entry.dispose(); entry.configuration?.close(); }
  }

  #retireSession(prefix: string): Promise<void> {
    this.#active.delete(prefix);
    const pending = this.#retiring.get(prefix);
    if (pending) return pending;
    const retiring: Promise<void>[] = [];
    for (const [key, entry] of this.#entries) if (key.startsWith(prefix)) {
      this.#entries.delete(key); retiring.push(this.#retire(entry));
    }
    if (retiring.length === 0) return Promise.resolve();
    const settled = Promise.all(retiring).then(() => {}).finally(() => {
      if (this.#retiring.get(prefix) === settled) this.#retiring.delete(prefix);
    });
    this.#retiring.set(prefix, settled);
    return settled;
  }

  async prepare(ctx: ExtensionContext, task: TaskContract): Promise<CompletionPreparation | false> {
    const options = this.#options;
    const prefix = this.#session(ctx), generation = this.#active.get(prefix);
    const preparation = Object.freeze({ isCurrent: () => {
      try {
        return generation !== undefined && this.#active.get(prefix) === generation
          && this.#session(ctx) === prefix && task.sessionId === ctx.sessionManager.getSessionId()
          && options.activeTask(ctx)?.taskRunId === task.taskRunId;
      } catch { return false; }
    } });
    if (!preparation.isCurrent()) return false;
    if (!options.configPath || task.trace.outcome !== "pending") return preparation;
    const key = this.#key(ctx, task);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { dispose: () => {}, runners: [], controller: new AbortController() };
      const owned = entry;
      owned.dispose = registerIndependentAcceptanceProvider(ctx.cwd, task, (_projected: TaskContract, digest: string) => {
        if (owned.controller.signal.aborted) return { block: "independent verification is stopping", stopReason: "stopping" };
        if (owned.block) return { block: owned.block, stopReason: "approval" };
        if (!owned.configuration?.isCurrent()) return { block: "independent host approval or installed verifier changed", stopReason: "approval" };
        if (owned.stop) return { block: `independent verification is blocked: ${owned.stop.reason}`, stopReason: owned.stop.reason, stopAttemptId: owned.stop.attemptId };
        const active = options.activeTask(ctx), snapshot = captureWorkspaceVerificationSnapshot(ctx.cwd);
        const projectVerificationDigest = active && snapshot.digest === digest
          ? options.state.projectVerification.currentDigest(ctx, active, snapshot, undefined, { completedProjection: true }) : null;
        return { entries: owned.runners.map((item) => ({ ...item.contract, receipt: item.receipt })), projectVerificationDigest };
      });
      this.#entries.set(key, owned);
      while (this.#entries.size > 100) {
        const oldest = this.#entries.keys().next().value as string, removed = this.#entries.get(oldest)!;
        this.#entries.delete(oldest); await this.#retire(removed);
      }
      if (owned.controller.signal.aborted || !preparation.isCurrent()) {
        if (this.#entries.get(key) === owned) this.#entries.delete(key);
        await this.#retire(owned);
        return false;
      }
      try {
        const configuration = openHostContractConfiguration({ configPath: options.configPath, projectRoot: ctx.cwd, installedRoot: options.installedRoot });
        owned.configuration = configuration;
        const approvedRequest = configuration.forRequest(task.operatorRequestDigest);
        if (!approvedRequest) return preparation;
        for (const contract of approvedRequest.contracts) {
          if (!task.acceptanceReceipt?.criteria.some((criterion) => criterion.id === contract.criterionId && criterion.hash === contract.criterionHash)) {
            throw new Error("Approved criterion mismatch");
          }
          const sourcePaths = new Set([contract.sourcePath, ...(contract.modulePaths ?? [])]);
          const runner = createRuntimeContractRunner({ state: options.state, context: ctx, getTask: () => options.activeTask(ctx),
            approved: { store: configuration.store, sourcePath: contract.sourcePath, modulePaths: contract.modulePaths, exportName: contract.exportName, checks: contract.checks,
              ...approvedRequest.backend, verifierDigest: approvedRequest.verifierDigest,
              authorizeSourceRead: ({ sourcePath }) => (!sourcePaths.has(sourcePath) || configuration.isCurrent()) && options.authorizeSourceRead(ctx, sourcePath) } });
          owned.runners.push({ contract, runner });
        }
      } catch { owned.block = "independent host approval is unavailable or does not match the task"; }
    }
    if (entry.controller.signal.aborted || !preparation.isCurrent()) return false;
    if (entry.block || !entry.configuration?.isCurrent()) return preparation;
    if (entry.pending) { await entry.pending; return !entry.controller.signal.aborted && preparation.isCurrent() ? preparation : false; }
    const owned = entry;
    owned.stop = undefined;
    const pending = (async () => {
      for (const item of owned.runners) {
        if (owned.controller.signal.aborted) break;
        try {
          const result = await item.runner.run({ scope: { taskRunId: task.taskRunId, criterionId: item.contract.criterionId },
            criterionHash: item.contract.criterionHash, maxAttempts: item.contract.maxAttempts, signal: owned.controller.signal });
          const reason = ({ "evidence-pending": "pending", "evidence-interrupted": "interrupted", "evidence-exhausted": "exhausted" } as Record<string, string>)[result.reason];
          const observed = result.evidence?.observed;
          const executionThrew = observed !== null && typeof observed === "object" && "reason" in observed && observed.reason === "independent-execution-threw";
          if (reason || executionThrew) {
            owned.stop = { reason: reason ?? "unavailable", attemptId: result.attemptId }; item.receipt = undefined; break;
          }
          item.receipt = await item.runner.assess(result, { policy: "allow" });
        } catch { item.receipt = undefined; owned.stop = { reason: "unavailable" }; break; }
      }
    })();
    owned.pending = pending;
    try { await pending; } finally { if (owned.pending === pending) owned.pending = undefined; }
    return !owned.controller.signal.aborted && preparation.isCurrent() ? preparation : false;
  }

  clear(ctx: ExtensionContext): Promise<void> { return this.#retireSession(this.#session(ctx)); }
}
