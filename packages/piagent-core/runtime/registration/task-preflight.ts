import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatSolverPreflight, solverPreflightProjection } from "../solver/solver-explanation.ts";
import type { SolverShadowEvaluation } from "../solver/solver-shadow.ts";
import type { TrajectoryStatus } from "../trajectory/trajectory-runtime.ts";
import { buildProductPreflight, formatProductPreflight } from "../product/operator-projections.ts";

type TaskPreflightDependencies = {
  emitContext: (ctx: ExtensionContext, request: string, compact: boolean) => void;
  evaluate: (ctx: ExtensionContext, request: string) => SolverShadowEvaluation;
  emit: (ctx: ExtensionContext, customType: string, content: string, details: Record<string, unknown>) => void;
  trajectoryStatus?: (ctx: ExtensionContext) => TrajectoryStatus;
  productInput?: (ctx: ExtensionContext, evaluation: SolverShadowEvaluation) => Parameters<typeof buildProductPreflight>[1] | Promise<Parameters<typeof buildProductPreflight>[1]>;
};

export function registerTaskPreflightCommand(pi: ExtensionAPI, dependencies: TaskPreflightDependencies): void {
  pi.registerCommand("task-preflight", {
    description: "Explain context and deterministic shadow route without a model follow-up",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const json = /(?:^|\s)--json(?:\s|$)/i.test(raw);
      const compact = /(?:^|\s)compact(?:\s|$)/i.test(raw);
      const request = raw.replace(/(?:^|\s)--json(?=\s|$)/ig, " ").replace(/(?:^|\s)compact(?=\s|$)/ig, " ").trim() || "task";
      const evaluation = dependencies.evaluate(ctx, request);
      if (!json) dependencies.emitContext(ctx, request, compact);
      const projection = solverPreflightProjection(evaluation);
      const trajectory = dependencies.trajectoryStatus?.(ctx) ?? { taskRunId: null, phase: null, enforcementSafe: true, warnings: [] };
      const product = buildProductPreflight(evaluation, await dependencies.productInput?.(ctx, evaluation));
      const details = { ...projection, product, trajectory };
      const human = evaluation.status === "ok" ? formatProductPreflight(product) : formatSolverPreflight(evaluation);
      const content = json ? JSON.stringify(details) : `${human}\ntrajectory: phase=${trajectory.phase ?? "none"}; enforcement=${trajectory.enforcementSafe ? "safe" : "disabled"}`;
      dependencies.emit(ctx, "piagent-solver-preflight", content, details);
    }
  });
}
