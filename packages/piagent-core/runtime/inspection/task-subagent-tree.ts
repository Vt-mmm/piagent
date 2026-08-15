import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { inspectOwnedWorkBudget, type OwnedWorkReservation } from "../orchestration/owned-work-budget.ts";
import { taskRunOpaqueRef } from "./task-run-index.ts";

type Task = { taskId: string; taskRunId: string; trace?: { outcome?: unknown }; orchestration?: Record<string, unknown>;
  acceptanceReceipt?: { helperUsage?: { used?: unknown; helpers?: unknown[] } }; [key: string]: any };
type Identity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string;
  agentOperationId: null; toolCallId: null };

function opaque(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(`piagent-webui-subagent-tree-v1\0${value}`).digest("hex").slice(0, 48)}`;
}

function display(value: unknown, maximum = 120): string | null {
  const text = redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : null;
}

function helperReceipts(task: Task): Map<string, Record<string, any>> {
  const helpers = task.acceptanceReceipt?.helperUsage?.helpers;
  const map = new Map<string, Record<string, any>>();
  if (!Array.isArray(helpers)) return map;
  for (const helper of helpers.slice(0, 64)) {
    if (!helper || typeof helper !== "object" || Array.isArray(helper)) continue;
    const item = helper as Record<string, any>;
    if (typeof item.requestRef === "string" && /^[a-f0-9]{64}$/.test(item.requestRef)) map.set(item.requestRef, item);
  }
  return map;
}

function child(taskRunId: string, parentRef: string, item: OwnedWorkReservation, receipt: Record<string, any> | undefined) {
  const nodeRef = opaque("helper", `${taskRunId}\0${item.id}`);
  const disposition = display(receipt?.disposition, 80);
  const staleResult = disposition === "stale-result";
  const resultState = staleResult ? "stale-result" : item.status === "succeeded" && item.usageRef ? "accepted"
    : receipt ? "rejected" : "not-recorded";
  return {
    nodeRef, parentRef, role: item.role, authority: item.authority, lifecycleState: item.status,
    reservedAt: item.reservedAt, expiresAt: item.expiresAt, completedAt: item.completedAt,
    currentWriter: item.status === "active" && item.authority === "single-writer",
    result: { state: resultState, disposition, calls: item.usageRef?.calls ?? null, tokens: item.usageRef?.tokens ?? null }
  };
}

function orchestration(task: Task) {
  const mode = task.orchestration?.mode;
  const subagents = task.orchestration?.subagents;
  return {
    mode: ["solo-first", "bounded-subagents", "parallel-readonly"].includes(String(mode)) ? mode : "unknown",
    subagents: ["not-used", "optional", "used"].includes(String(subagents)) ? subagents : "unknown"
  };
}

function unavailable(identity: Identity, runRef: string, generatedAt: string, reasonCode: string) {
  return { schemaVersion: 1, version: "piagent-webui-subagent-tree-v1", generatedAt, identity: structuredClone(identity), runRef,
    state: "unavailable", treeRevision: null, evidenceState: "unknown", orchestration: { mode: "unknown", subagents: "unknown" },
    parent: null, children: [], writer: { state: "unknown", ownerNodeRef: null },
    nestedLineage: { state: "unavailable", reasonCode: "no-durable-nested-lineage" },
    summary: { total: 0, active: 0, completed: 0, staleResults: 0, readOnly: 0, singleWriter: 0 }, warnings: [],
    health: { state: "error", reasonCode, message: "Helper/subagent evidence is unavailable." } };
}

export function projectTaskSubagentTree(input: { cwd: string; task: Task; identity: Identity; generatedAt?: string }): Record<string, any> {
  const generatedAt = input.generatedAt ?? new Date().toISOString(), runRef = taskRunOpaqueRef(input.task.taskRunId);
  const inspected = inspectOwnedWorkBudget(input.cwd, input.task.taskId, input.task.taskRunId, generatedAt);
  if (inspected.state === "corrupt") return unavailable(input.identity, runRef, generatedAt, inspected.reasonCode ?? "helper-budget-corrupt");
  const policy = orchestration(input.task), parentRef = opaque("parent", input.task.taskRunId), receipts = helperReceipts(input.task);
  const children = inspected.reservations.map((item) => child(input.task.taskRunId, parentRef, item, receipts.get(item.deduplicationKey)));
  const matchedReceipts = new Set(inspected.reservations.map((item) => item.deduplicationKey).filter((key) => receipts.has(key)));
  const unmatchedReceipts = Math.max(0, receipts.size - matchedReceipts.size);
  const activeWriter = children.find((item) => item.currentWriter);
  const outcome = String(input.task.trace?.outcome ?? "unknown");
  const parentState = outcome === "pending" ? "active" : ["completed", "blocked", "partial", "failed"].includes(outcome) ? "terminal" : "unknown";
  const aggregateEvidence = policy.mode !== "unknown" || policy.subagents !== "unknown" || receipts.size > 0;
  const evidenceState = inspected.state === "ready" ? unmatchedReceipts ? "partial" : "complete" : aggregateEvidence ? "aggregate-only" : "missing";
  const warnings: Array<{ code: string; count: number; message: string }> = [];
  if (inspected.state === "missing") warnings.push({ code: "helper-budget-missing", count: 1,
    message: "Only aggregate orchestration evidence is available; helper lifecycle detail cannot be reconstructed." });
  if (inspected.derivedOrphans) warnings.push({ code: "expired-helper-derived-orphan", count: inspected.derivedOrphans,
    message: `${inspected.derivedOrphans} expired active helper reservation(s) are displayed as orphaned without changing runtime state.` });
  if (unmatchedReceipts) warnings.push({ code: "helper-receipt-unmatched", count: unmatchedReceipts,
    message: `${unmatchedReceipts} helper receipt(s) cannot be linked to a durable reservation.` });
  const writer = activeWriter ? { state: "helper", ownerNodeRef: activeWriter.nodeRef }
    : inspected.state === "ready" || policy.subagents === "not-used" ? { state: "parent", ownerNodeRef: parentRef }
      : { state: "unknown", ownerNodeRef: null };
  const summary = { total: children.length, active: children.filter((item) => item.lifecycleState === "active").length,
    completed: children.filter((item) => item.lifecycleState !== "active").length,
    staleResults: children.filter((item) => item.result.state === "stale-result").length,
    readOnly: children.filter((item) => item.authority === "read-only").length,
    singleWriter: children.filter((item) => item.authority === "single-writer").length };
  const treeRevision = `subagent-tree.${createHash("sha256").update(JSON.stringify({ policy, parentState, terminal: inspected.terminal,
    children, writer, evidenceState })).digest("hex")}`;
  return { schemaVersion: 1, version: "piagent-webui-subagent-tree-v1", generatedAt, identity: structuredClone(input.identity), runRef,
    state: "ready", treeRevision, evidenceState, orchestration: policy,
    parent: { nodeRef: parentRef, lifecycleState: parentState, budgetTerminal: inspected.terminal, mergeOwner: "parent" }, children, writer,
    nestedLineage: { state: "unavailable", reasonCode: "no-durable-nested-lineage" }, summary, warnings,
    health: warnings.length ? { state: "degraded", reasonCode: "subagent-tree-incomplete", message: "Some helper/subagent evidence is incomplete." }
      : { state: "ok", reasonCode: null, message: null } };
}
