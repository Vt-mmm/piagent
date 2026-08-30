import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { toolResultFingerprint } from "../../extensions/context-engine.js";
import { claimedExitMatchesObserved, hashEvidenceCommand, observedBashResultFromToolResultEvent } from "../../extensions/runtime-evidence.js";
import { meaningfulVerificationCommands } from "../../extensions/verification-intelligence.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import type { ShellVerificationSnapshots } from "./shell-verification-snapshots.ts";

export const HOST_PROJECT_VERIFICATION_VERSION = "host-project-verification-v1";
type Snapshot = ReturnType<typeof captureWorkspaceVerificationSnapshot>;
type ToolEvent = { toolCallId?: string; toolName: string; input?: unknown; details?: unknown; isError?: boolean };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function taskBinding(task: TaskContract): string {
  return hash([task.taskId, task.taskRunId, task.sessionId, task.operatorRequestDigest ?? null,
    task.verifyCommands, task.acceptanceReceipt?.promptHash ?? null,
    task.acceptanceReceipt?.criteria.map(({ id, hash: criterionHash }) => [id, criterionHash]) ?? []]);
}

/** Host-only live observations, never reconstructed from task JSON or stdout. */
export class HostProjectVerification {
  readonly #invocations: ShellVerificationSnapshots;
  readonly #latest = new Map<string, { taskBinding: string; digest: string; revision: string } | null>();
  constructor(invocations: ShellVerificationSnapshots) { this.#invocations = invocations; }
  #prefix(ctx: ExtensionContext): string { return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}\0`; }
  #key(ctx: ExtensionContext, task: TaskContract, commandHash: string): string { return `${this.#prefix(ctx)}${task.taskRunId}\0${commandHash}`; }

  observe(ctx: ExtensionContext, task: TaskContract | undefined, event: ToolEvent, before: Snapshot | undefined, after: Snapshot | undefined): void {
    if (!task || task.trace.outcome !== "pending" || task.sessionId !== ctx.sessionManager.getSessionId()) return;
    const observed = observedBashResultFromToolResultEvent(event, ctx.cwd);
    if (!observed?.commandHash || !meaningfulVerificationCommands(task.verifyCommands).some((command) => hashEvidenceCommand(command) === observed.commandHash)) return;
    const callId = event.toolCallId ?? toolResultFingerprint(event.toolName, event.input, []).key;
    const issued = this.#invocations.claimObservation(ctx, event.toolName, event.input, callId, task.taskRunId, before);
    const key = this.#key(ctx, task, observed.commandHash);
    // Every new result replaces the previous result, including unavailable,
    // unmatched, contradictory, or failed observations. No timestamp selection.
    this.#latest.set(key, issued && before?.proofCapable && after?.proofCapable
      && before.digest === after.digest && before.workspaceRevisionDigest === after.workspaceRevisionDigest
      && claimedExitMatchesObserved(0, { ...observed, isError: event.isError }) && event.isError !== true
      ? { taskBinding: taskBinding(task), digest: after.digest, revision: after.workspaceRevisionDigest! } : null);
    while (this.#latest.size > 500) this.#latest.delete(this.#latest.keys().next().value as string);
  }

  currentDigest(ctx: ExtensionContext, task: TaskContract, current: Snapshot, exactCommand?: string): string | null {
    if (task.trace.outcome !== "pending" || task.sessionId !== ctx.sessionManager.getSessionId() || !current.proofCapable) return null;
    if (this.#invocations.hasPending(ctx, task.taskRunId)) return null;
    const commands = meaningfulVerificationCommands(task.verifyCommands);
    if (commands.length === 0 || commands.length !== task.verifyCommands.length) return null;
    const selected = exactCommand === undefined ? commands : commands.filter((command) => hashEvidenceCommand(command) === hashEvidenceCommand(exactCommand));
    if (selected.length === 0) return null;
    const binding = taskBinding(task), commandHashes = selected.map(hashEvidenceCommand);
    if (commandHashes.some((command) => !command)) return null;
    for (const command of commandHashes) {
      const entry = this.#latest.get(this.#key(ctx, task, command));
      if (!entry || entry.taskBinding !== binding || entry.digest !== current.digest || entry.revision !== current.workspaceRevisionDigest) return null;
    }
    // Equivalent newly observed passing checks can reuse the same independent
    // evidence. Availability comes from live state, not from this public hash.
    return hash([HOST_PROJECT_VERIFICATION_VERSION, ctx.cwd, binding, current.digest, current.workspaceRevisionDigest, commandHashes]);
  }

  clear(ctx: ExtensionContext): void {
    const prefix = this.#prefix(ctx);
    for (const key of this.#latest.keys()) if (key.startsWith(prefix)) this.#latest.delete(key);
  }
}
