import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import type { TaskContract } from "../../extensions/guard-types.ts";

export type ObservedTaskContext = { path: string; reason: string };

export type InjectedContextPack = {
  queryHash: string;
  confidence: string;
  estimatedTokens: number;
  paths: string[];
};

function evictOldest<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) map.delete(map.keys().next().value as K);
}

export class RuntimeSessionState {
  readonly #maxObservedContext: number;
  readonly #advisedTools = new Set<string>();
  readonly #seenToolResults = new Map<string, { outputHash: string; recordedAt: string }>();
  readonly #autoPackedPrompts = new Set<string>();
  readonly #injectedContextPacks = new Map<string, InjectedContextPack>();
  readonly #completionRecoveryAttempts = new Map<string, number>();
  readonly #taskIdentityBySession = new Map<string, { taskId: string; taskRunId: string }>();
  readonly #observedContextBySession = new Map<string, Map<string, ObservedTaskContext>>();
  readonly #shellMutationSnapshots = new Map<string, Record<string, string>>();

  constructor(options: { maxObservedContext: number }) {
    this.#maxObservedContext = options.maxObservedContext;
  }

  sessionKey(ctx: ExtensionContext): string {
    return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
  }

  cacheTaskIdentity(ctx: ExtensionContext, task: TaskContract | undefined): void {
    const key = this.sessionKey(ctx);
    if (task) this.#taskIdentityBySession.set(key, { taskId: task.taskId, taskRunId: task.taskRunId });
    else this.#taskIdentityBySession.delete(key);
    evictOldest(this.#taskIdentityBySession, 100);
  }

  taskIdentity(ctx: ExtensionContext): { taskId: string; taskRunId: string } | undefined {
    return this.#taskIdentityBySession.get(this.sessionKey(ctx));
  }

  hasAdvisedTool(ctx: ExtensionContext, toolName: string): boolean {
    return this.#advisedTools.has(`${this.sessionKey(ctx)}\u0000${toolName}`);
  }

  rememberAdvisedTool(ctx: ExtensionContext, toolName: string): void {
    this.#advisedTools.add(`${this.sessionKey(ctx)}\u0000${toolName}`);
    while (this.#advisedTools.size > 500) {
      this.#advisedTools.delete(this.#advisedTools.values().next().value as string);
    }
  }

  rememberObservedContext(ctx: ExtensionContext, entry: ObservedTaskContext): void {
    const key = this.sessionKey(ctx);
    let observed = this.#observedContextBySession.get(key);
    if (!observed) {
      observed = new Map();
      this.#observedContextBySession.set(key, observed);
    }
    if (!observed.has(entry.path)) observed.set(entry.path, entry);
    evictOldest(observed, this.#maxObservedContext);
    evictOldest(this.#observedContextBySession, 100);
  }

  observedContext(ctx: ExtensionContext): ObservedTaskContext[] {
    return [...(this.#observedContextBySession.get(this.sessionKey(ctx))?.values() ?? [])];
  }

  clearObservedContext(ctx: ExtensionContext): void {
    this.#observedContextBySession.delete(this.sessionKey(ctx));
  }

  #shellMutationSnapshotKey(ctx: ExtensionContext, toolName: string, input: unknown): string {
    return `${this.sessionKey(ctx)}\u0000${toolResultFingerprint(toolName, input, []).key}`;
  }

  rememberShellMutationSnapshot(ctx: ExtensionContext, toolName: string, input: unknown): void {
    this.#shellMutationSnapshots.set(
      this.#shellMutationSnapshotKey(ctx, toolName, input),
      workingTreeSnapshot(ctx.cwd) as Record<string, string>
    );
    evictOldest(this.#shellMutationSnapshots, 100);
  }

  consumeShellMutationSnapshot(ctx: ExtensionContext, toolName: string, input: unknown): Record<string, string> | undefined {
    const key = this.#shellMutationSnapshotKey(ctx, toolName, input);
    const snapshot = this.#shellMutationSnapshots.get(key);
    this.#shellMutationSnapshots.delete(key);
    return snapshot;
  }

  clearShellMutationSnapshots(ctx: ExtensionContext): void {
    const prefix = `${this.sessionKey(ctx)}\u0000`;
    for (const key of this.#shellMutationSnapshots.keys()) {
      if (key.startsWith(prefix)) this.#shellMutationSnapshots.delete(key);
    }
  }

  hasAutoPackedPrompt(key: string): boolean {
    return this.#autoPackedPrompts.has(key);
  }

  rememberAutoPackedPrompt(key: string): void {
    this.#autoPackedPrompts.add(key);
    while (this.#autoPackedPrompts.size > 50) {
      this.#autoPackedPrompts.delete(this.#autoPackedPrompts.values().next().value as string);
    }
  }

  rememberInjectedContextPack(ctx: ExtensionContext, key: string, pack: InjectedContextPack): void {
    this.#injectedContextPacks.set(`${this.sessionKey(ctx)}\u0000${key}`, pack);
    evictOldest(this.#injectedContextPacks, 50);
  }

  injectedContextPack(ctx: ExtensionContext, key: string): InjectedContextPack | undefined {
    return this.#injectedContextPacks.get(`${this.sessionKey(ctx)}\u0000${key}`);
  }

  completionRecoveryAttempt(taskRunId: string): number {
    return this.#completionRecoveryAttempts.get(taskRunId) ?? 0;
  }

  rememberCompletionRecoveryAttempt(taskRunId: string, attempt: number): void {
    this.#completionRecoveryAttempts.set(taskRunId, attempt);
    evictOldest(this.#completionRecoveryAttempts, 100);
  }

  clearCompletionRecoveryAttempt(taskRunId: string): void {
    this.#completionRecoveryAttempts.delete(taskRunId);
  }

  previousToolResult(
    ctx: ExtensionContext,
    fingerprintKey: string
  ): { outputHash: string; recordedAt: string } | undefined {
    return this.#seenToolResults.get(`${this.sessionKey(ctx)}\u0000${fingerprintKey}`);
  }

  rememberToolResult(
    ctx: ExtensionContext,
    fingerprintKey: string,
    value: { outputHash: string; recordedAt: string }
  ): void {
    this.#seenToolResults.set(`${this.sessionKey(ctx)}\u0000${fingerprintKey}`, value);
    evictOldest(this.#seenToolResults, 500);
  }

  clearSession(ctx: ExtensionContext): void {
    const sessionKey = this.sessionKey(ctx);
    const prefix = `${sessionKey}\u0000`;
    const taskIdentity = this.#taskIdentityBySession.get(sessionKey);
    this.#taskIdentityBySession.delete(sessionKey);
    this.#observedContextBySession.delete(sessionKey);
    this.clearShellMutationSnapshots(ctx);
    if (taskIdentity) this.#completionRecoveryAttempts.delete(taskIdentity.taskRunId);
    for (const values of [this.#advisedTools, this.#autoPackedPrompts]) {
      for (const key of values) {
        if (key.startsWith(prefix)) values.delete(key);
      }
    }
    for (const values of [this.#seenToolResults, this.#injectedContextPacks]) {
      for (const key of values.keys()) {
        if (key.startsWith(prefix)) values.delete(key);
      }
    }
  }
}
