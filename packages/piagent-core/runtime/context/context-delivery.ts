import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.js";
import type { PendingContextDelivery, RuntimeSessionState, ObservedTaskContext } from "../session/runtime-state.ts";

export type ContextDeliveryConfirmationDependencies = {
  state: RuntimeSessionState;
  maxManifestFiles: number;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  flushObservedTaskContext: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number,
    event: string
  ) => TaskContract | undefined;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

export function contextDeliveryIdFromDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const rawDelivery = (details as { contextDelivery?: unknown }).contextDelivery;
  if (!rawDelivery || typeof rawDelivery !== "object" || Array.isArray(rawDelivery)) return undefined;
  const deliveryId = (rawDelivery as { deliveryId?: unknown }).deliveryId;
  return typeof deliveryId === "string" && deliveryId.length > 0 && deliveryId.length <= 200
    ? deliveryId
    : undefined;
}

export function confirmContextDelivery(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deliveryId: string,
  dependencies: ContextDeliveryConfirmationDependencies
): TaskContract | undefined {
  const delivery = dependencies.state.takeContextDelivery(ctx, deliveryId);
  if (!delivery) return undefined;
  const task = dependencies.activeTask(ctx);
  if (!task || task.trace.outcome !== "pending" || task.taskRunId !== delivery.taskRunId) {
    dependencies.telemetry(ctx, { event: "context_delivery_rejected", deliveryId, reason: "task-identity-mismatch" });
    return undefined;
  }
  for (const entry of delivery.entries) {
    dependencies.state.rememberObservedContext(ctx, entry);
    dependencies.state.rememberQualifiedContextEvidence(ctx, delivery.taskRunId, entry);
  }
  const written = dependencies.flushObservedTaskContext(
    pi,
    ctx,
    dependencies.state.qualifiedContextEvidence(ctx, delivery.taskRunId),
    dependencies.maxManifestFiles,
    "context_delivery_confirmed"
  );
  if (!written || written.taskRunId !== delivery.taskRunId) return undefined;
  if (delivery.pack) {
    const { retrievalKey, ...pack } = delivery.pack;
    dependencies.state.rememberInjectedContextPack(ctx, retrievalKey, pack);
  }
  dependencies.telemetry(ctx, {
    event: "context_delivery_confirmed",
    deliveryId,
    turnId: delivery.turnId,
    taskId: written.taskId,
    taskRunId: written.taskRunId,
    selectedPaths: delivery.entries.map((entry) => entry.path),
    selected: delivery.entries.length
  });
  if (delivery.injection) dependencies.telemetry(ctx, {
    event: "context_pack_injected",
    injectionId: deliveryId,
    turnId: delivery.turnId,
    ...delivery.injection,
    selectedPaths: delivery.injection.selectedItems.map((item) => item.path)
  });
  return written;
}

export function stageContextDelivery(
  ctx: ExtensionContext,
  delivery: PendingContextDelivery,
  dependencies: Pick<ContextDeliveryConfirmationDependencies, "state" | "telemetry">
): void {
  dependencies.state.stageContextDelivery(ctx, delivery);
  if (!delivery.injection) return;
  dependencies.telemetry(ctx, {
    event: "context_pack_offered",
    deliveryId: delivery.deliveryId,
    turnId: delivery.turnId,
    ...delivery.injection,
    selectedPaths: delivery.injection.selectedItems.map((item) => item.path)
  });
}

export function confirmContextDeliveryFromToolResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: { details?: unknown; isError?: boolean },
  dependencies: ContextDeliveryConfirmationDependencies
): TaskContract | undefined {
  if (event.isError === true) return undefined;
  const deliveryId = contextDeliveryIdFromDetails(event.details);
  return deliveryId ? confirmContextDelivery(pi, ctx, deliveryId, dependencies) : undefined;
}
