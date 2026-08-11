import crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TrajectorySyncResult } from "./trajectory-runtime.ts";

const reportedRecovery = new Set<string>();

export function observeTrajectorySync(
  ctx: ExtensionContext,
  result: TrajectorySyncResult | undefined,
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void
): void {
  if (!result) return;
  if (!result.enforcementSafe) {
    const warning = result.warnings[0] ?? "Trajectory state is corrupt; phase enforcement is disabled.";
    const key = crypto.createHash("sha256").update(`${ctx.cwd}\0${warning}`).digest("hex");
    if (!reportedRecovery.has(key)) {
      reportedRecovery.add(key);
      while (reportedRecovery.size > 100) reportedRecovery.delete(reportedRecovery.values().next().value as string);
      ctx.ui.notify(`Piagent trajectory needs recovery; phase enforcement is disabled: ${warning}`, "warning");
    }
    return;
  }
  for (const transition of result.transitions) {
    telemetry(ctx, {
      event: "trajectory_transition",
      taskId: transition.taskId,
      taskRunId: transition.taskRunId,
      eventId: transition.eventId,
      sequence: transition.sequence,
      from: transition.from,
      to: transition.to,
      cause: transition.cause,
      sourceHook: transition.sourceHook,
      skippedPhases: transition.skippedPhases
    });
  }
}
