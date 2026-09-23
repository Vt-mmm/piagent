import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPiagentTool } from "./extension-registration.ts";
import { MAX_SESSION_WAIT_SECONDS, SESSION_WAIT_ENTRY, SessionWaitRuntime } from "../tools/session-wait.ts";

/** Reuse the host session journal; pending waits never schedule work on resume. */
export function registerSessionWaitTool(pi: ExtensionAPI, Type: any): void {
  const waits = new SessionWaitRuntime();
  const key = (ctx: ExtensionContext) => `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) {
    pi.on(event, async (_event: unknown, ctx: ExtensionContext) => { waits.interrupt(key(ctx)); });
  }
  registerPiagentTool(pi, {
    name: "piagent_wait",
    label: "Wait until the next check",
    description: "Wait 1–3600 seconds within this open session without polling or calling a model. Use when the next useful check is later. No background scheduling, condition monitoring, command execution, or completion evidence. Cancel to interrupt.",
    promptSnippet: "For a future check, wait once until it is useful; avoid repeated unchanged status checks.",
    promptGuidelines: [
      "Use a process/event wait tool when it can wake on completion; otherwise choose the next useful check time within the task deadline. Call this tool alone so cancellation can stop its batch.",
      "Do independent work first. Keep the next check explicit; waiting never completes a task or proves an external action succeeded.",
      "This requires an open running session. After interruption or restart, reconcile pending work before deciding to wait again; never replay uncertain external actions."
    ],
    parameters: Type.Object({
      seconds: Type.Number({ minimum: 1, maximum: MAX_SESSION_WAIT_SECONDS, multipleOf: 1 }),
      nextCheck: Type.String({ minLength: 1, maxLength: 240, description: "The specific observation to make when the wait ends, not a command to execute automatically." })
    }),
    async execute(toolCallId: string, params: { seconds: number; nextCheck: string }, signal: AbortSignal | undefined,
      _onUpdate: unknown, ctx: ExtensionContext) {
      if (!Number.isInteger(params.seconds) || params.seconds < 1 || params.seconds > MAX_SESSION_WAIT_SECONDS
        || typeof params.nextCheck !== "string" || !params.nextCheck.trim() || params.nextCheck.length > 240) {
        throw new Error("Use a bounded wait of 1–3600 seconds and a nonempty next check of at most 240 characters.");
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const prior = ctx.sessionManager.getBranch().some((entry: any) => entry.type === "custom"
        && entry.customType === SESSION_WAIT_ENTRY && entry.data?.toolCallId === toolCallId);
      if (prior) throw new Error("This wait call is already journaled. Reconcile its result; do not replay it after resume.");
      if (signal?.aborted) throw new Error("Wait interrupted before starting; no follow-up was scheduled.");
      const startedAt = new Date().toISOString();
      const identity = { toolCallId, sessionId, startedAt, seconds: params.seconds };
      pi.appendEntry(SESSION_WAIT_ENTRY, { ...identity, outcome: "pending" });
      const result = await waits.wait(key(ctx), params.seconds, signal);
      // Never append a receipt to a different session after a switch.
      if (ctx.sessionManager.getSessionId() === sessionId) {
        pi.appendEntry(SESSION_WAIT_ENTRY, { ...identity, ...result });
      }
      return {
        terminate: result.outcome === "interrupted",
        content: [{ type: "text", text: result.outcome === "elapsed"
          ? `Wait elapsed. Next check: ${params.nextCheck}. No condition was checked; task completion and external outcomes remain unverified.`
          : `Wait interrupted. Pending next check: ${params.nextCheck}. No follow-up was scheduled; reconcile current state before continuing.` }],
        details: { ...identity, ...result, conditionChecked: false, followUpScheduled: false }
      };
    }
  });
}
