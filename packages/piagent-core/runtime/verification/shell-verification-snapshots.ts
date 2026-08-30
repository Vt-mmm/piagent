import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";

/** Host invocation state; equal commands in parallel must not consume each other. */
export class ShellVerificationSnapshots {
  readonly #snapshots = new Map<string, ReturnType<typeof captureWorkspaceVerificationSnapshot> | null>();

  #key(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId?: string, taskRunId = ""): string {
    const fingerprint = toolResultFingerprint(toolName, input, []).key;
    return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}\u0000${taskRunId}\u0000${toolCallId ?? fingerprint}\u0000${fingerprint}`;
  }

  remember(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId?: string, taskRunId?: string): void {
    const key = this.#key(ctx, toolName, input, toolCallId, taskRunId);
    // Ambiguous duplicate invocation IDs cannot supply a before-snapshot.
    if (this.#snapshots.has(key)) { this.#snapshots.set(key, null); return; }
    this.#snapshots.set(key, captureWorkspaceVerificationSnapshot(ctx.cwd));
    while (this.#snapshots.size > 100) this.#snapshots.delete(this.#snapshots.keys().next().value as string);
  }

  consume(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId?: string, taskRunId?: string) {
    const key = this.#key(ctx, toolName, input, toolCallId, taskRunId);
    const snapshot = this.#snapshots.get(key);
    this.#snapshots.delete(key);
    return snapshot ?? undefined;
  }

  clear(ctx: ExtensionContext): void {
    const prefix = `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}\u0000`;
    for (const key of this.#snapshots.keys()) if (key.startsWith(prefix)) this.#snapshots.delete(key);
  }
}
