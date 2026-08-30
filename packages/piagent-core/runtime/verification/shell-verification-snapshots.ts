import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";

/** Host invocation state; equal commands in parallel must not consume each other. */
export class ShellVerificationSnapshots {
  readonly #snapshots = new Map<string, ReturnType<typeof captureWorkspaceVerificationSnapshot> | null>();
  readonly #consumed = new Map<string, ReturnType<typeof captureWorkspaceVerificationSnapshot>>();
  #overflowed = false;

  #key(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId?: string, taskRunId = ""): string {
    const fingerprint = toolResultFingerprint(toolName, input, []).key;
    return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}\u0000${taskRunId}\u0000${toolCallId ?? fingerprint}\u0000${fingerprint}`;
  }

  remember(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId?: string, taskRunId?: string): void {
    const key = this.#key(ctx, toolName, input, toolCallId, taskRunId);
    // Ambiguous duplicate invocation IDs cannot supply a before-snapshot.
    if (this.#snapshots.has(key)) { this.#snapshots.set(key, null); return; }
    this.#snapshots.set(key, captureWorkspaceVerificationSnapshot(ctx.cwd));
    while (this.#snapshots.size > 100) {
      this.#overflowed = true; // Lost in-flight identity cannot become a cached pass later in this process.
      this.#snapshots.delete(this.#snapshots.keys().next().value as string);
    }
  }

  consume(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId?: string, taskRunId?: string) {
    const key = this.#key(ctx, toolName, input, toolCallId, taskRunId);
    const snapshot = this.#snapshots.get(key);
    this.#snapshots.delete(key);
    if (snapshot) {
      this.#consumed.set(key, snapshot);
      while (this.#consumed.size > 100) this.#consumed.delete(this.#consumed.keys().next().value as string);
    }
    return snapshot ?? undefined;
  }

  claimObservation(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId: string | undefined,
    taskRunId: string, snapshot: ReturnType<typeof captureWorkspaceVerificationSnapshot> | undefined): boolean {
    const key = this.#key(ctx, toolName, input, toolCallId, taskRunId);
    const issued = this.#consumed.get(key);
    this.#consumed.delete(key);
    return issued !== undefined && issued === snapshot;
  }

  hasPending(ctx: ExtensionContext, taskRunId: string): boolean {
    const prefix = `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}\0${taskRunId}\0`;
    return this.#overflowed || [...this.#snapshots.keys()].some((key) => key.startsWith(prefix));
  }

  clear(ctx: ExtensionContext): void {
    const prefix = `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}\u0000`;
    for (const key of this.#snapshots.keys()) if (key.startsWith(prefix)) this.#snapshots.delete(key);
    for (const key of this.#consumed.keys()) if (key.startsWith(prefix)) this.#consumed.delete(key);
  }
}
