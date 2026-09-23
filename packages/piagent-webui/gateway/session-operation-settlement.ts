import { settleIndependentWebUiOperation } from "../../piagent-core/extensions/acceptance-independent-registry.js";
import type { activeSessionTask } from "../../piagent-core/extensions/task-state.js";
import type { GatewaySessionStream } from "./gateway-session-stream.ts";
import type { ScopedBrokerRouter } from "./session-runtime-factory.ts";

type SettlementInput = { sessionId: string; operationRef: string; messageRequestId: string | null;
  manager: any; stream: Pick<GatewaySessionStream, "markBlocked" | "markError"> };

export function createSessionOperationSettlement(options: {
  scopedBrokerRouter?: ScopedBrokerRouter;
  compositeSettlementEvidence?(): unknown | Promise<unknown>;
}) {
  const router = options.scopedBrokerRouter;
  const evidence = options.compositeSettlementEvidence ?? (router ? () => router.settlementEvidence()
    : () => { throw new Error("composite-settlement-evidence-unavailable"); });
  return async (cwd: string, task: ReturnType<typeof activeSessionTask>, input: SettlementInput) => {
    const { sessionId, operationRef, messageRequestId, manager, stream } = input;
    const settlement = await settleIndependentWebUiOperation(cwd, task,
      { operationRef, messageRequestId, manager, evidence });
    if (settlement.status === "blocked") stream.markBlocked("composite-settlement-blocked");
    if (settlement.status === "not-applicable" && task?.trace?.outcome === "completed"
      && router?.discardUnusedSettlement && messageRequestId) {
      try { router.discardUnusedSettlement({ sessionId, operationRef, messageRequestId }); }
      catch { stream.markError("scoped-operation-retirement-failed"); }
    }
    return settlement;
  };
}
