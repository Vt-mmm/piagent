import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";

import { webUiMessageCorrelationEntry, type WebUiMessageCorrelation } from "../shared/message-correlation.ts";

// As in CoreInspectionProvider, load core through the server boundary. Its
// internal source types are not part of the strict browser contract graph.
const CORE_ROOT = "../../piagent-core";
const [{ activeSessionTask }, { isUncertainSendContinuation, terminalUncertainSendReceipt }] = await Promise.all([
  import(`${CORE_ROOT}/extensions/task-state.js`),
  import(`${CORE_ROOT}/runtime/session/uncertain-send-continuation.ts`)
]);

export type TerminalDeliveryReceipt = { customType: string; content: string; details: {
  taskId: string; taskRunId: string; outcome: string; completionApproved: boolean; gateDecision: string;
  [key: string]: unknown;
} };

export function readTerminalDeliveryReceipt(cwd: string, task: unknown): TerminalDeliveryReceipt | undefined {
  return terminalUncertainSendReceipt(cwd, task);
}

export const TERMINAL_DELIVERY_CONFIRMATION_TYPE = "piagent-webui-terminal-delivery-v1";
export type TerminalDeliveryPair = { requestEntry: any; receiptEntry: any; confirmationEntry?: any; request: string;
  correlation: WebUiMessageCorrelation; receipt: TerminalDeliveryReceipt };

/** Strict bounded readback; an in-memory Pi branch is not a persistence acknowledgment. */
export function terminalDeliverySessionEntries(file: string | undefined, sessionId: string): unknown[] {
  if (!file) return [];
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return [];
    const source = fs.readFileSync(descriptor, "utf8");
    if (!source.endsWith("\n") || Buffer.byteLength(source) > 64 * 1024 * 1024) return [];
    const lines = source.trimEnd().split("\n");
    if (lines.length > 50_001) return [];
    // Pi's generic parser tolerates corrupt lines. Delivery requires every
    // persisted record, including the confirmation, to be complete and valid.
    const [header, ...entries] = lines.map((line) => JSON.parse(line));
    return header?.type === "session" && header.version === 3 && header.id === sessionId ? entries : [];
  } catch { return []; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Only this handled-input protocol needs a request anchor outside model history. */
export function terminalDeliveryRequest(message: unknown, images?: unknown[]): string | undefined {
  return typeof message === "string" && message.length <= 65_536 && !images?.length
    && isUncertainSendContinuation(message) ? message : undefined;
}

function matchesReceipt(value: any, expected: TerminalDeliveryReceipt): boolean {
  return value?.display === true && value.customType === expected.customType && value.content === expected.content
    && isDeepStrictEqual(value.details, expected.details);
}

function hasEntryIdentity(value: any): boolean {
  return typeof value?.id === "string" && value.id.length > 0 && value.id.length <= 160
    && typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp));
}

function confirmationData(pair: TerminalDeliveryPair): Record<string, unknown> {
  return { schemaVersion: 1, ...pair.correlation, receiptEntryId: pair.receiptEntry.id,
    taskId: pair.receipt.details.taskId, taskRunId: pair.receipt.details.taskRunId };
}

function receiptPairs(entries: unknown[], expected: TerminalDeliveryReceipt | undefined,
  confirmed: boolean): TerminalDeliveryPair[] {
  if (!expected || !Array.isArray(entries) || entries.length > 50_000) return [];
  const pairs: TerminalDeliveryPair[] = [];
  const operations = new Map<string, number>(), requests = new Map<string, number>(), entryIds = new Map<string, number>();
  for (const entry of entries) {
    const id = (entry as any)?.id;
    if (typeof id === "string") entryIds.set(id, (entryIds.get(id) ?? 0) + 1);
    const correlation = webUiMessageCorrelationEntry(entry);
    if (correlation) {
      operations.set(correlation.operationRef, (operations.get(correlation.operationRef) ?? 0) + 1);
      requests.set(correlation.messageRequestId, (requests.get(correlation.messageRequestId) ?? 0) + 1);
    }
  }
  for (let index = 1; index < entries.length; index += 1) {
    const requestEntry = entries[index - 1] as any, receiptEntry = entries[index] as any;
    const correlation = webUiMessageCorrelationEntry(requestEntry);
    const request = terminalDeliveryRequest(requestEntry?.data?.terminalDeliveryRequest);
    if (!correlation || request === undefined || receiptEntry?.type !== "custom_message"
      || !hasEntryIdentity(requestEntry) || !hasEntryIdentity(receiptEntry)
      || entryIds.get(requestEntry.id) !== 1 || entryIds.get(receiptEntry.id) !== 1
      || !matchesReceipt(receiptEntry, expected)) continue;
    const pair: TerminalDeliveryPair = { requestEntry, receiptEntry, request, correlation, receipt: expected };
    if (confirmed) {
      const confirmation = entries[index + 1] as any;
      if (confirmation?.type !== "custom" || confirmation.customType !== TERMINAL_DELIVERY_CONFIRMATION_TYPE
        || !hasEntryIdentity(confirmation) || entryIds.get(confirmation.id) !== 1
        || !isDeepStrictEqual(confirmation.data, confirmationData(pair))) continue;
      pair.confirmationEntry = confirmation;
    }
    pairs.push(pair);
  }
  return pairs.filter((pair) => operations.get(pair.correlation.operationRef) === 1
    && requests.get(pair.correlation.messageRequestId) === 1);
}

/** A projection may show only a receipt whose operation reached durable delivery settlement. */
export function terminalDeliveryPairs(entries: unknown[], expected: TerminalDeliveryReceipt | undefined,
  persistedEntries: unknown[] = []): TerminalDeliveryPair[] {
  const persisted = new Map(receiptPairs(persistedEntries, expected, true).map((pair) => [pair.receiptEntry.id, pair]));
  return receiptPairs(entries, expected, true).filter((pair) => {
    const disk = persisted.get(pair.receiptEntry.id);
    return disk && isDeepStrictEqual(pair.requestEntry, disk.requestEntry) && isDeepStrictEqual(pair.receiptEntry, disk.receiptEntry)
      && isDeepStrictEqual(pair.confirmationEntry, disk.confirmationEntry);
  });
}

/**
 * Compare the observed custom message with current core state and this exact
 * operation's latest durable receipt. Persist a delivery observation before
 * the gateway acknowledges settlement. This marker grants no task authority;
 * transcript reads still require the independently reread core receipt.
 */
export function terminalDeliveryReceiptCommitter(input: { cwd: string; sessionId: string; operationRef: string;
  messageRequestId: string | null; request?: string; entries(): unknown[]; persistedEntries(): unknown[];
  appendCustomEntry(type: string, data: Record<string, unknown>): unknown }):
  (message: unknown) => TerminalDeliveryReceipt | undefined {
  return (message) => {
    if (input.request === undefined || !input.messageRequestId || (message as any)?.role !== "custom") return undefined;
    try {
      const expected = readTerminalDeliveryReceipt(input.cwd, activeSessionTask(input.cwd, input.sessionId));
      const entries = input.entries(), pair = receiptPairs(entries, expected, false).find((candidate) =>
        candidate.correlation.operationRef === input.operationRef
        && candidate.correlation.messageRequestId === input.messageRequestId && candidate.request === input.request);
      if (!pair || pair.receiptEntry !== entries.at(-1) || !matchesReceipt(message, pair.receipt)) return undefined;
      const before = input.persistedEntries();
      const disk = receiptPairs(before, expected, false).find((candidate) => candidate.receiptEntry.id === pair.receiptEntry.id);
      if (!disk || disk.receiptEntry !== before.at(-1) || !isDeepStrictEqual(pair.requestEntry, disk.requestEntry)
        || !isDeepStrictEqual(pair.receiptEntry, disk.receiptEntry)) return undefined;
      input.appendCustomEntry(TERMINAL_DELIVERY_CONFIRMATION_TYPE, confirmationData(pair));
      const current = input.entries(), persisted = input.persistedEntries();
      return terminalDeliveryPairs(current, expected, persisted).some((candidate) => candidate.receiptEntry.id === pair.receiptEntry.id
        && candidate.confirmationEntry === current.at(-1) && candidate.confirmationEntry.id === (persisted.at(-1) as any)?.id)
        ? pair.receipt : undefined;
    } catch { return undefined; }
  };
}
