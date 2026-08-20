import { useCallback, useEffect, useRef, useState } from "react";

import type { PiagentGatewayCapabilityHandshakeV1 } from "../../contracts/generated/gateway-capabilities-v1.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import type { Catalog, SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PermissionMode, Receipt, Workflow } from "../../contracts/generated/session-command-v1.ts";
import { readSessionCatalog } from "./api.ts";
import { bootstrapBrowserSession } from "./bootstrap.ts";
import type { ConnectionState } from "./use-inspection.ts";

export type LiveActivity = { toolCallRef: string; toolLabel: string; state: "running" | "completed" | "failed" };
export type LiveConversation = { user: string; assistant: string; attachments: Attachment[]; activities: LiveActivity[];
  operationRef: string | null; complete: boolean; error: string | null };

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
  refresh(): Promise<Catalog | undefined>;
  create(options: { projectRef: string; placeRef: string; modelRef: string | null; thinkingLevel: string; message: string;
    workflow: Workflow; permissionMode: PermissionMode | null; messageRequestId?: string; deferInitialMessage?: boolean }): Promise<Receipt>;
  send(session: SessionRow, message: string, attachment?: { messageRequestId: string; attachmentRefs: string[]; attachments?: Attachment[];
    workflow?: Workflow }): Promise<Receipt>;
  abort(session: SessionRow): Promise<Receipt>;
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
  const catalogRef = useRef<Catalog | undefined>(undefined), socketRef = useRef<WebSocket | null>(null), sequenceRef = useRef(0);
  const refreshStartedRef = useRef(0), refreshAppliedRef = useRef(0);
  const pendingRef = useRef(new Map<string, { resolve(value: Receipt): void; reject(error: Error): void }>());
  const refresh = useCallback(async () => {
    const refreshSequence = ++refreshStartedRef.current;
    try {
      const value = await readSessionCatalog();
      if (refreshSequence >= refreshAppliedRef.current) {
        refreshAppliedRef.current = refreshSequence; catalogRef.current = value; setCatalog(value); setConnection("connected");
      }
      return catalogRef.current ?? value;
    } catch { setConnection("reconnecting"); return undefined; }
  }, []);

  const request = useCallback((command: unknown): Promise<Receipt> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("gateway-not-connected"));
    const requestId = opaque("request");
    return new Promise((resolve, reject) => {
      pendingRef.current.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "request",
        requestId, method: "sessions.command", params: { command } }));
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
    if (receipt.phase !== "settled" || !receipt.sessionRef) throw new Error(receipt.error?.code ?? receipt.resultCode);
    if (!options.deferInitialMessage) setLive((value) => ({ ...value, [receipt.sessionRef!]: { ...(value[receipt.sessionRef!]
      ?? { assistant: "", attachments: [], activities: [], complete: false, error: null }), user: message, operationRef: receipt.operationRef } }));
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
    setLive((value) => ({ ...value, [session.sessionRef]: { user: text, assistant: "", attachments: attachment?.attachments ?? [], activities: [],
      operationRef: null, complete: false, error: null } }));
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
      setLive((value) => ({ ...value, [session.sessionRef]: { ...(value[session.sessionRef] ?? { user: text, assistant: "", attachments: [], activities: [], complete: false, error: null }),
        operationRef: receipt.operationRef } }));
      if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
      void refresh(); return receipt;
    } catch (error) {
      setLive((value) => ({ ...value, [session.sessionRef]: { ...(value[session.sessionRef] ?? { user: text, assistant: "", attachments: [], activities: [], operationRef: null, complete: false }),
        error: error instanceof Error ? error.message : "session-send-failed" } }));
      throw error;
    }
  }, [refresh, request]);

  const abort = useCallback(async (session: SessionRow) => {
    const current = catalogRef.current, operationRef = live[session.sessionRef]?.operationRef;
    const exact = current?.sessions.find((item) => item.sessionRef === session.sessionRef);
    if (!current?.catalogRevision || !exact || !operationRef) throw new Error("operation-unavailable");
    const now = new Date(), receipt = await request({ schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command",
      commandId: opaque("command"), idempotencyKey: opaque("idempotency"), action: "session.abort", requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: session.sessionRef,
      expectedCatalogRevision: current.catalogRevision, expectedSessionRevision: exact.sessionRevision,
      payload: { operationRef, clearQueued: true } });
    if (receipt.phase !== "settled") throw new Error(receipt.error?.code ?? receipt.resultCode);
    void refresh(); return receipt;
  }, [live, refresh, request]);

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
    let stopped = false, reconnectTimer: number | undefined, attempt = 0;
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
        if (frame.messageType === "hello") { window.clearTimeout(helloTimeout); attempt = 0; setCapabilities(frame.capabilities); setConnection("connected"); return; }
        if (frame.messageType === "response") {
          const pending = pendingRef.current.get(String(frame.requestId)); if (!pending) return;
          pendingRef.current.delete(String(frame.requestId));
          if (frame.ok === true && frame.result) pending.resolve(frame.result as Receipt);
          else pending.reject(new Error(String(frame.error?.code ?? "gateway-request-failed")));
          return;
        }
        if (frame.messageType !== "event" || !Number.isSafeInteger(frame.sequence)) return;
        sequenceRef.current = Math.max(sequenceRef.current, Number(frame.sequence));
        const payload = frame.payload as Record<string, any>;
        if (frame.kind === "message.delta" && typeof payload?.sessionRef === "string" && typeof payload.delta === "string") {
          setLive((current) => ({ ...current, [payload.sessionRef]: { ...(current[payload.sessionRef]
            ?? { user: "", assistant: "", attachments: [], activities: [], complete: false, error: null }), operationRef: payload.operationRef,
            assistant: `${current[payload.sessionRef]?.assistant ?? ""}${payload.delta}` } }));
        }
        if (["tool.started", "tool.completed"].includes(String(frame.kind)) && typeof payload?.sessionRef === "string"
          && typeof payload.toolCallRef === "string" && typeof payload.toolLabel === "string") {
          setLive((current) => {
            const existing = current[payload.sessionRef] ?? { user: "", assistant: "", attachments: [], activities: [],
              operationRef: payload.operationRef ?? null, complete: false, error: null };
            const state: LiveActivity["state"] = frame.kind === "tool.started" ? "running" : payload.isError === true ? "failed" : "completed";
            const activities = [...existing.activities.filter((item) => item.toolCallRef !== payload.toolCallRef),
              { toolCallRef: payload.toolCallRef, toolLabel: payload.toolLabel, state }].slice(-16);
            return { ...current, [payload.sessionRef]: { ...existing, operationRef: payload.operationRef ?? existing.operationRef, activities } };
          });
        }
        if (frame.kind === "message.completed" && typeof payload?.sessionRef === "string") {
          setLive((current) => ({ ...current, [payload.sessionRef]: { ...(current[payload.sessionRef]
            ?? { user: "", assistant: "", attachments: [], activities: [], operationRef: payload.operationRef, error: null }), complete: true } }));
        }
        if (["catalog.changed", "session.changed", "runtime.changed", "message.completed", "resync.required"].includes(String(frame.kind))) void refresh();
      });
      socket.addEventListener("close", () => {
        window.clearTimeout(helloTimeout); if (stopped) return; setConnection("reconnecting");
        for (const pending of pendingRef.current.values()) pending.reject(new Error("gateway-connection-lost")); pendingRef.current.clear();
        attempt += 1; reconnectTimer = window.setTimeout(connect, Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
      });
      socket.addEventListener("error", () => { /* close owns reconnect */ });
    };
    void (async () => {
      const bootstrap = await bootstrapBrowserSession(); if (stopped) return;
      if (bootstrap === "failed") { setConnection("failed"); return; }
      const value = await readSessionCatalog().catch(() => undefined); if (stopped) return;
      if (!value) { setConnection("failed"); return; }
      catalogRef.current = value; setCatalog(value); connect();
    })();
    const visible = () => { if (!stopped && document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; if (reconnectTimer) window.clearTimeout(reconnectTimer); socketRef.current?.close(1000, "client-unmount");
      document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  return { catalog, capabilities, connection, live, refresh, create, send, abort, setModel, setThinking, setPermission,
    rename, pin, archive, unarchive, fork };
}
