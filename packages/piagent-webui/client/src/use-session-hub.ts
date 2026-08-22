import { useCallback, useEffect, useRef, useState } from "react";

import type { PiagentGatewayCapabilityHandshakeV1 } from "../../contracts/generated/gateway-capabilities-v1.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import type { Catalog, SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PermissionMode, Receipt, Workflow } from "../../contracts/generated/session-command-v1.ts";
import { readSessionCatalog, readSessionLiveState } from "./api.ts";
import { bootstrapBrowserSession } from "./bootstrap.ts";
import { applyOperationSettlement, canonicalLiveStateSequence, connectionStateAfterCatalogRefresh, liveStateConfirmsAbort,
  mergeTerminalOperationActivities, reconcileSessionLiveState,
  reconcileTerminalOperationActivities, terminalOperationActivity, type LiveActivity, type LiveConversation,
  type TerminalOperationActivity } from "./live-state-view-model.ts";
import type { ConnectionState } from "./use-inspection.ts";

export { applyOperationSettlement, canonicalLiveStateSequence, connectionStateAfterCatalogRefresh, liveStateConfirmsAbort,
  mergeTerminalOperationActivities, reconcileSessionLiveState,
  reconcileTerminalOperationActivities, terminalOperationActivity };
export type { LiveActivity, LiveConversation, TerminalOperationActivity };

type GatewayCursor = { gatewayInstanceRef: string; sequence: number };
const GATEWAY_CURSOR_KEY = "piagent-gateway-event-cursor-v1";
const COMMAND_RESPONSE_TIMEOUT_MS = 30_000;
const CANONICAL_RESYNC_CLOSE_CODE = 4_001;

export function parseGatewayCursor(raw: string | null, gatewayInstanceRef: string): number | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GatewayCursor>;
    return value.gatewayInstanceRef === gatewayInstanceRef && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
      ? Number(value.sequence) : null;
  } catch { return null; }
}

function opaque(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }

function revisionStale(receipt: Receipt): boolean {
  return receipt.phase === "rejected" && receipt.resultCode === "stale-revision"
    && receipt.error?.code === "session-revision-stale";
}

export function useSessionHub(): {
  catalog?: Catalog;
  capabilities?: PiagentGatewayCapabilityHandshakeV1;
  connection: ConnectionState;
  live: Readonly<Record<string, LiveConversation>>;
  terminalActivities: Readonly<Record<string, TerminalOperationActivity[]>>;
  refresh(): Promise<Catalog | undefined>;
  create(options: { projectRef: string; placeRef: string; modelRef: string | null; thinkingLevel: string; message: string;
    workflow: Workflow; permissionMode: PermissionMode | null; messageRequestId?: string; deferInitialMessage?: boolean }): Promise<Receipt>;
  send(session: SessionRow, message: string, attachment?: { messageRequestId: string; attachmentRefs: string[]; attachments?: Attachment[];
    workflow?: Workflow }): Promise<Receipt>;
  abort(session: SessionRow): Promise<Receipt>;
  restart(session: SessionRow): Promise<Receipt>;
  setModel(session: SessionRow, modelRef: string): Promise<Receipt>;
  setThinking(session: SessionRow, thinkingLevel: string): Promise<Receipt>;
  setPermission(session: SessionRow, permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<Receipt>;
  rename(session: SessionRow, title: string): Promise<Receipt>;
  pin(session: SessionRow, pinned: boolean): Promise<Receipt>;
  archive(session: SessionRow): Promise<Receipt>;
  unarchive(session: SessionRow): Promise<Receipt>;
  fork(session: SessionRow, title: string | null): Promise<Receipt>;
} {
  const [catalog, setCatalog] = useState<Catalog>();
  const [capabilities, setCapabilities] = useState<PiagentGatewayCapabilityHandshakeV1>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [live, setLive] = useState<Record<string, LiveConversation>>({});
  const [terminalActivities, setTerminalActivities] = useState<Record<string, TerminalOperationActivity[]>>({});
  const catalogRef = useRef<Catalog | undefined>(undefined), socketRef = useRef<WebSocket | null>(null), sequenceRef = useRef<number | null>(null);
  const gatewayInstanceRef = useRef<string | null>(null);
  const canonicalRefreshRequiredRef = useRef(true);
  const refreshStartedRef = useRef(0), refreshAppliedRef = useRef(0);
  const pendingRef = useRef(new Map<string, { resolve(value: Receipt): void; reject(error: Error): void; timeout: number }>());
  const persistCursor = useCallback((gatewayRef: string, sequence: number | null) => {
    if (sequence === null) return;
    try { window.sessionStorage.setItem(GATEWAY_CURSOR_KEY, JSON.stringify({ gatewayInstanceRef: gatewayRef, sequence })); }
    catch { /* Cursor persistence is an optimization; live-state remains canonical. */ }
  }, []);
  const refresh = useCallback(async (options: { requireLiveState?: boolean } = {}) => {
    const refreshSequence = ++refreshStartedRef.current;
    try {
      const [value, liveState] = await Promise.all([readSessionCatalog(), readSessionLiveState().catch(() => undefined)]);
      const canonicalSequence = canonicalLiveStateSequence(liveState, value.gatewayInstanceRef);
      let canonicalApplied = false;
      if (refreshSequence >= refreshAppliedRef.current) {
        refreshAppliedRef.current = refreshSequence; catalogRef.current = value; setCatalog(value);
        const previousGateway = gatewayInstanceRef.current;
        if (previousGateway !== null && previousGateway !== value.gatewayInstanceRef) canonicalRefreshRequiredRef.current = true;
        gatewayInstanceRef.current = value.gatewayInstanceRef;
        const canonicalRequired = options.requireLiveState || canonicalRefreshRequiredRef.current;
        // A live-state sequence is a bootstrap/resync cursor, never a shortcut
        // over frames already queued on an open socket. Advancing it during an
        // ordinary catalog refresh could skip the terminal settlement outcome.
        const socketOpen = socketRef.current?.readyState === WebSocket.OPEN;
        setConnection(connectionStateAfterCatalogRefresh(socketOpen, canonicalRequired));
        if (!socketOpen && liveState && canonicalSequence !== null) {
          sequenceRef.current = canonicalSequence; persistCursor(value.gatewayInstanceRef, canonicalSequence);
          setLive((current) => reconcileSessionLiveState(current, liveState));
          setTerminalActivities(reconcileTerminalOperationActivities(liveState));
          canonicalRefreshRequiredRef.current = false;
          canonicalApplied = true;
        } else if (previousGateway !== value.gatewayInstanceRef) {
          // Terminal Activity is volatile to one Gateway epoch. Never carry an
          // old outcome into a restarted Gateway that cannot prove it.
          setTerminalActivities({});
          if (canonicalRequired) sequenceRef.current = null;
          else {
            let stored: string | null = null;
            try { stored = window.sessionStorage.getItem(GATEWAY_CURSOR_KEY); } catch { /* unavailable storage */ }
            sequenceRef.current = parseGatewayCursor(stored, value.gatewayInstanceRef);
          }
        }
      }
      if (options.requireLiveState && !canonicalApplied) return undefined;
      return catalogRef.current ?? value;
    } catch { setConnection("reconnecting"); return undefined; }
  }, [persistCursor]);

  const request = useCallback((command: unknown): Promise<Receipt> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("gateway-not-connected"));
    const requestId = opaque("request");
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!pendingRef.current.delete(requestId)) return;
        reject(new Error("gateway-command-response-timeout"));
      }, COMMAND_RESPONSE_TIMEOUT_MS);
      pendingRef.current.set(requestId, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "request",
          requestId, method: "sessions.command", params: { command } }));
      } catch (error) {
        window.clearTimeout(timeout); pendingRef.current.delete(requestId);
        reject(error instanceof Error ? error : new Error("gateway-request-failed"));
      }
    });
  }, []);

  const create = useCallback(async (options: { projectRef: string; placeRef: string; modelRef: string | null;
    thinkingLevel: string; workflow: Workflow; permissionMode: PermissionMode | null; message: string; messageRequestId?: string; deferInitialMessage?: boolean }) => {
    const current = catalogRef.current, message = options.message.trim(), messageRequestId = options.messageRequestId ?? opaque("message");
    if (!current?.catalogRevision) throw new Error("catalog-unavailable");
    if (!message) throw new Error("message-empty");
    const submit = (snapshot: Catalog) => {
      if (!snapshot.catalogRevision) throw new Error("catalog-unavailable");
      const now = new Date();
      return request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
        commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action: "session.create", requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: null,
        expectedCatalogRevision: snapshot.catalogRevision, expectedSessionRevision: null,
        payload: { projectRef: options.projectRef, placeRef: options.placeRef, modelRef: options.modelRef,
          thinkingLevel: options.thinkingLevel, workflow: options.workflow, message, messageRequestId,
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
          ...(options.deferInitialMessage ? { deferInitialMessage: true } : {}) } });
    };
    let receipt = await submit(current);
    if (revisionStale(receipt)) {
      const latest = await refresh();
      if (latest?.catalogRevision) receipt = await submit(latest);
    }
    const knownUncertainSession = receipt.phase === "uncertain" && Boolean(receipt.sessionRef);
    if ((!knownUncertainSession && receipt.phase !== "settled") || !receipt.sessionRef) throw new Error(receipt.error?.code ?? receipt.resultCode);
    if (receipt.phase === "settled" && !options.deferInitialMessage) setLive((value) => {
      const existing = value[receipt.sessionRef!];
      return { ...value, [receipt.sessionRef!]: { ...(existing
        ?? { assistant: "", attachments: [], activities: [], complete: false, error: null }), user: message,
        operationRef: receipt.operationRef, abortable: existing?.complete ? false : Boolean(receipt.operationRef) } };
    });
    await refresh(); return receipt;
  }, [refresh, request]);

  // The composer owns the messageRequestId whenever it has staged attachments,
  // because the bytes were staged against that exact id before the message
  // existed. Without attachments a fresh id per send is still correct.
  const send = useCallback(async (session: SessionRow, message: string,
    attachment?: { messageRequestId: string; attachmentRefs: string[]; attachments?: Attachment[]; workflow?: Workflow }) => {
    const current = catalogRef.current;
    if (!current?.catalogRevision) throw new Error("catalog-unavailable");
    const text = message.trim(); if (!text) throw new Error("message-empty");
    const messageRequestId = attachment?.messageRequestId ?? opaque("message");
    const attachmentRefs = attachment?.attachmentRefs ?? [];
    try {
      const submit = (snapshot: Catalog) => {
        const exact = snapshot.sessions.find((item) => item.sessionRef === session.sessionRef);
        if (!snapshot.catalogRevision || !exact) throw new Error("session-unavailable");
        const now = new Date();
        return request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
          commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action: "session.send", requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: session.sessionRef,
          expectedCatalogRevision: snapshot.catalogRevision, expectedSessionRevision: exact.sessionRevision,
          payload: { delivery: "new-operation", message: text, messageRequestId, expectedOperationRef: null, attachmentRefs,
            ...(attachment?.workflow ? { workflow: attachment.workflow } : {}) } });
      };
      let receipt = await submit(current);
      if (revisionStale(receipt)) {
        const latest = await refresh();
        if (latest?.catalogRevision) receipt = await submit(latest);
      }
      if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
      // Only an admitted operation may enter the transcript. Runtime events can
      // arrive before the receipt; merge the user message into that exact live
      // operation without showing rejected/unsent input optimistically.
      setLive((value) => {
        const existing = value[session.sessionRef];
        return { ...value, [session.sessionRef]: { ...(existing ?? { assistant: "", activities: [], complete: false,
          error: null }), user: text, attachments: attachment?.attachments ?? [], operationRef: receipt.operationRef,
          abortable: existing?.complete ? false : Boolean(receipt.operationRef) } };
      });
      void refresh(); return receipt;
    } catch (error) { throw error; }
  }, [refresh, request]);

  const abort = useCallback(async (session: SessionRow) => {
    const current = catalogRef.current, operationRef = live[session.sessionRef]?.operationRef;
    const exact = current?.sessions.find((item) => item.sessionRef === session.sessionRef);
    if (!current?.catalogRevision || !exact || !operationRef || live[session.sessionRef]?.abortable === false) throw new Error("operation-unavailable");
    const submit = (snapshot: Catalog) => {
      const row = snapshot.sessions.find((item) => item.sessionRef === session.sessionRef);
      if (!snapshot.catalogRevision || !row) throw new Error("operation-unavailable");
      const now = new Date();
      return request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
        commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action: "session.abort", requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: session.sessionRef,
        expectedCatalogRevision: snapshot.catalogRevision, expectedSessionRevision: row.sessionRevision,
        payload: { operationRef, clearQueued: true } });
    };
    let receipt = await submit(current);
    if (revisionStale(receipt)) {
      const [latest, liveState] = await Promise.all([refresh(), readSessionLiveState().catch(() => undefined)]);
      // One stale-revision retry is safe only when the canonical volatile model
      // still proves this exact operation is active and abortable.
      if (!latest || !liveStateConfirmsAbort(liveState, latest.gatewayInstanceRef, session.sessionRef, operationRef)) {
        throw new Error("operation-unavailable");
      }
      receipt = await submit(latest);
    }
    if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
    void refresh(); return receipt;
  }, [live, refresh, request]);

  const restart = useCallback(async (session: SessionRow) => {
    const invoke = async (action: "session.release" | "session.acquire"): Promise<Receipt> => {
      const current = await refresh(), exact = current?.sessions.find((item) => item.sessionRef === session.sessionRef);
      if (!current?.catalogRevision || !exact) throw new Error("session-unavailable");
      const now = new Date(), receipt = await request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
        commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action, requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: session.sessionRef,
        expectedCatalogRevision: current.catalogRevision, expectedSessionRevision: exact.sessionRevision, payload: {} });
      if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
      return receipt;
    };
    setLive((current) => ({ ...current, [session.sessionRef]: { ...(current[session.sessionRef]
      ?? { user: "", assistant: "", attachments: [], activities: [], operationRef: null, complete: true, error: null }), runtimeRecovery: "restarting" } }));
    try {
      const current = await refresh(), exact = current?.sessions.find((item) => item.sessionRef === session.sessionRef);
      if (!exact) throw new Error("session-unavailable");
      if (exact.state === "gateway-owned") await invoke("session.release");
      const receipt = await invoke("session.acquire");
      setLive((value) => ({ ...value, [session.sessionRef]: { ...(value[session.sessionRef]
        ?? { user: "", assistant: "", attachments: [], activities: [], operationRef: null, complete: true, error: null }), runtimeRecovery: "recovered" } }));
      await refresh(); return receipt;
    } catch (error) {
      setLive((value) => ({ ...value, [session.sessionRef]: { ...(value[session.sessionRef]
        ?? { user: "", assistant: "", attachments: [], activities: [], operationRef: null, complete: true, error: null }), runtimeRecovery: "failed" } }));
      throw error;
    }
  }, [refresh, request]);

  const setSessionOption = useCallback(async (session: SessionRow, action: "session.set-model" | "session.set-thinking" | "session.set-permission",
    payload: { modelRef: string } | { thinkingLevel: string } | { permissionMode: "read-only" | "workspace-write" | "trusted-full-access" }) => {
    const current = catalogRef.current, exact = current?.sessions.find((item) => item.sessionRef === session.sessionRef);
    if (!current?.catalogRevision || !exact) throw new Error("session-unavailable");
    const now = new Date(), receipt = await request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
      commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action, requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: session.sessionRef,
      expectedCatalogRevision: current.catalogRevision, expectedSessionRevision: exact.sessionRevision, payload });
    if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
    await refresh(); return receipt;
  }, [refresh, request]);
  const setModel = useCallback((session: SessionRow, modelRef: string) => setSessionOption(session, "session.set-model", { modelRef }), [setSessionOption]);
  const setThinking = useCallback((session: SessionRow, thinkingLevel: string) => setSessionOption(session, "session.set-thinking", { thinkingLevel }), [setSessionOption]);
  const setPermission = useCallback((session: SessionRow, permissionMode: "read-only" | "workspace-write" | "trusted-full-access") =>
    setSessionOption(session, "session.set-permission", { permissionMode }), [setSessionOption]);

  const mutateSession = useCallback(async (session: SessionRow,
    action: "session.rename" | "session.pin" | "session.archive" | "session.unarchive" | "session.fork", payload: Record<string, unknown>) => {
    const current = catalogRef.current, exact = current?.sessions.find((item) => item.sessionRef === session.sessionRef);
    if (!current?.catalogRevision || !exact) throw new Error("session-unavailable");
    const now = new Date(), receipt = await request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
      commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action, requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: session.sessionRef,
      expectedCatalogRevision: current.catalogRevision, expectedSessionRevision: exact.sessionRevision, payload });
    if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
    await refresh(); return receipt;
  }, [refresh, request]);
  const rename = useCallback((session: SessionRow, title: string) => mutateSession(session, "session.rename", { title }), [mutateSession]);
  const pin = useCallback((session: SessionRow, pinned: boolean) => mutateSession(session, "session.pin", { pinned }), [mutateSession]);
  const archive = useCallback((session: SessionRow) => mutateSession(session, "session.archive", {}), [mutateSession]);
  const unarchive = useCallback((session: SessionRow) => mutateSession(session, "session.unarchive", {}), [mutateSession]);
  const fork = useCallback((session: SessionRow, title: string | null) => mutateSession(session, "session.fork", { entryRef: null, title }), [mutateSession]);

  useEffect(() => {
    let stopped = false, reconnectTimer: number | undefined, attempt = 0, canonicalResync = false;
    const clientRef = (() => {
      try {
        const stored = window.localStorage.getItem("piagent-gateway-client-ref");
        if (stored && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(stored)) return stored;
        const created = opaque("client"); window.localStorage.setItem("piagent-gateway-client-ref", created); return created;
      } catch { return opaque("client"); }
    })();
    const connect = () => {
      if (stopped) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${window.location.host}/api/v1/gateway`, "piagent.gateway.v1"); socketRef.current = socket;
      const helloTimeout = window.setTimeout(() => socket.close(1008, "hello-timeout"), 5_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1",
        messageType: "connect", clientRef, minimumProtocol: 1, maximumProtocol: 1, lastEventSequence: sequenceRef.current,
        catalogRevision: catalogRef.current?.catalogRevision ?? null })));
      socket.addEventListener("message", (message) => {
        let value: unknown; try { value = JSON.parse(String(message.data)); } catch { socket.close(1007, "invalid-json"); return; }
        if (!value || typeof value !== "object") { socket.close(1008, "invalid-frame"); return; }
        const frame = value as Record<string, any>;
        if (frame.messageType === "hello") {
          window.clearTimeout(helloTimeout);
          const helloGateway = typeof frame.capabilities?.gatewayInstanceRef === "string" ? frame.capabilities.gatewayInstanceRef : null;
          if (!helloGateway || gatewayInstanceRef.current && helloGateway !== gatewayInstanceRef.current) {
            sequenceRef.current = null; canonicalRefreshRequiredRef.current = true;
            canonicalResync = true; socket.close(CANONICAL_RESYNC_CLOSE_CODE, "gateway-epoch-changed"); return;
          }
          gatewayInstanceRef.current = helloGateway; attempt = 0; setCapabilities(frame.capabilities); setConnection("connected"); return;
        }
        if (frame.messageType === "response") {
          const pending = pendingRef.current.get(String(frame.requestId)); if (!pending) return;
          pendingRef.current.delete(String(frame.requestId)); window.clearTimeout(pending.timeout);
          if (frame.ok === true && frame.result) pending.resolve(frame.result as Receipt);
          else pending.reject(new Error(String(frame.error?.code ?? "gateway-request-failed")));
          return;
        }
        if (frame.messageType !== "event" || !Number.isSafeInteger(frame.sequence)) return;
        const payload = frame.payload as Record<string, any>;
        if (frame.kind === "resync.required") {
          canonicalRefreshRequiredRef.current = true;
          canonicalResync = true; socket.close(CANONICAL_RESYNC_CLOSE_CODE, "canonical-resync-required"); return;
        }
        const incoming = Number(frame.sequence), previous = sequenceRef.current;
        if (previous !== null && incoming <= previous) return;
        if (previous !== null && incoming !== previous + 1) {
          canonicalRefreshRequiredRef.current = true;
          canonicalResync = true; socket.close(CANONICAL_RESYNC_CLOSE_CODE, "gateway-event-sequence-gap"); return;
        }
        sequenceRef.current = incoming;
        if (gatewayInstanceRef.current) persistCursor(gatewayInstanceRef.current, incoming);
        if (frame.kind === "message.delta" && typeof payload?.sessionRef === "string" && typeof payload.delta === "string") {
          setLive((current) => ({ ...current, [payload.sessionRef]: { ...(current[payload.sessionRef]
            ?? { user: "", assistant: "", attachments: [], activities: [], complete: false, error: null }), operationRef: payload.operationRef,
            abortable: true,
            assistant: `${current[payload.sessionRef]?.assistant ?? ""}${payload.delta}` } }));
        }
        if (["tool.started", "tool.completed"].includes(String(frame.kind)) && typeof payload?.sessionRef === "string"
          && typeof payload.toolCallRef === "string" && typeof payload.toolLabel === "string") {
          setLive((current) => {
            const existing = current[payload.sessionRef] ?? { user: "", assistant: "", attachments: [], activities: [],
              operationRef: payload.operationRef ?? null, abortable: true, complete: false, error: null, runtimeRecovery: null };
            const state: LiveActivity["state"] = frame.kind === "tool.started" ? "running" : payload.isError === true ? "failed" : "completed";
            const activities = [...existing.activities.filter((item) => item.toolCallRef !== payload.toolCallRef),
              { toolCallRef: payload.toolCallRef, toolLabel: payload.toolLabel, state, reasonCode: payload.reasonCode ?? null }].slice(-16);
            const runtimeRecovery = payload.reasonCode === "runtime-restart-required" ? "required" : existing.runtimeRecovery;
            return { ...current, [payload.sessionRef]: { ...existing, operationRef: payload.operationRef ?? existing.operationRef, activities, runtimeRecovery } };
          });
        }
        if (frame.kind === "runtime.changed" && typeof payload?.sessionRef === "string") {
          setLive((current) => {
            const active = ["running", "paused", "waiting-approval"].includes(String(payload.liveState));
            const existing = current[payload.sessionRef] ?? (active && typeof payload.operationRef === "string"
              ? { user: "", assistant: "", attachments: [], activities: [], operationRef: payload.operationRef,
                abortable: true, complete: false, settlement: null, error: null, runtimeRecovery: null }
              : null);
            if (!existing) return current;
            const runtimeRecovery = payload.reasonCode === "runtime-restart-required" ? "restarting"
              : payload.reasonCode === "runtime-restart-failed" ? "failed"
                : ["required", "restarting"].includes(String(existing.runtimeRecovery)) && payload.liveState === "idle" ? "recovered"
                  : existing.runtimeRecovery;
            if (active) {
              return { ...current, [payload.sessionRef]: { ...existing, operationRef: payload.operationRef ?? existing.operationRef,
                abortable: true, complete: false, settlement: null, runtimeRecovery } };
            }
            if (!existing.complete && payload.operationRef === null) {
              return { ...current, [payload.sessionRef]: { ...existing, assistant: "", abortable: false, complete: true, settlement: "unknown",
                error: payload.reasonCode ?? "operation-settlement-unknown", runtimeRecovery } };
            }
            return runtimeRecovery === existing.runtimeRecovery ? current
              : { ...current, [payload.sessionRef]: { ...existing, runtimeRecovery } };
          });
        }
        if (frame.kind === "message.completed" && typeof payload?.sessionRef === "string") {
          setLive((current) => ({ ...current, [payload.sessionRef]: { ...(current[payload.sessionRef]
            ?? { user: "", assistant: "", attachments: [], activities: [], operationRef: payload.operationRef, error: null }),
            operationRef: payload.operationRef, abortable: false, complete: true, settlement: "completed", error: null } }));
        }
        if (frame.kind === "operation.settled" && typeof payload?.sessionRef === "string"
          && typeof payload.operationRef === "string") {
          setLive((current) => {
            const existing = current[payload.sessionRef] ?? { user: "", assistant: "", attachments: [], activities: [],
              operationRef: payload.operationRef, complete: false, error: null, runtimeRecovery: null };
            if (existing.operationRef && existing.operationRef !== payload.operationRef) return current;
            return { ...current, [payload.sessionRef]: applyOperationSettlement(existing, {
              operationRef: payload.operationRef, settlement: payload.settlement, reasonCode: payload.reasonCode
            }) };
          });
          const terminal = terminalOperationActivity({ operationRef: payload.operationRef, settlement: payload.settlement,
            reasonCode: payload.reasonCode, settledAt: frame.generatedAt, sequence: incoming });
          if (terminal) setTerminalActivities((current) => ({ ...current,
            [payload.sessionRef]: mergeTerminalOperationActivities(current[payload.sessionRef] ?? [], [terminal]) }));
        }
        if (["catalog.changed", "session.changed", "runtime.changed", "message.completed", "operation.settled"].includes(String(frame.kind))) void refresh();
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(helloTimeout);
        for (const pending of pendingRef.current.values()) { window.clearTimeout(pending.timeout); pending.reject(new Error("gateway-connection-lost")); }
        pendingRef.current.clear();
        if (stopped) return; setConnection("reconnecting");
        if (canonicalResync) {
          canonicalResync = false;
          void requireCanonicalAndConnect();
          return;
        }
        attempt += 1; reconnectTimer = window.setTimeout(connect, Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
      });
      socket.addEventListener("error", () => { /* close owns reconnect */ });
    };
    const requireCanonicalAndConnect = async () => {
      if (stopped) return;
      const value = await refresh({ requireLiveState: true });
      if (stopped) return;
      if (value) { attempt = 0; connect(); return; }
      setConnection("reconnecting"); attempt += 1;
      reconnectTimer = window.setTimeout(() => void requireCanonicalAndConnect(), Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
    };
    void (async () => {
      const bootstrap = await bootstrapBrowserSession(); if (stopped) return;
      if (bootstrap === "failed") { setConnection("failed"); return; }
      await requireCanonicalAndConnect();
    })();
    const visible = () => { if (!stopped && document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; if (reconnectTimer) window.clearTimeout(reconnectTimer);
      for (const pending of pendingRef.current.values()) { window.clearTimeout(pending.timeout); pending.reject(new Error("gateway-client-unmounted")); }
      pendingRef.current.clear(); socketRef.current?.close(1000, "client-unmount");
      document.removeEventListener("visibilitychange", visible); };
  }, [persistCursor, refresh]);

  return { catalog, capabilities, connection, live, terminalActivities, refresh, create, send, abort, restart, setModel, setThinking, setPermission,
    rename, pin, archive, unarchive, fork };
}
