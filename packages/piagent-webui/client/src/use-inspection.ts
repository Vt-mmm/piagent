import { useCallback, useEffect, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { readSnapshot } from "./api.ts";
import { bootstrapBrowserSession } from "./bootstrap.ts";
import type { RuntimeStreamEvent } from "./chat-view-model.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "failed";

export function useInspection(): { snapshot?: PiagentWebUICanonicalSnapshotV1; connection: ConnectionState; events: RuntimeStreamEvent[];
  refreshSnapshot(): Promise<PiagentWebUICanonicalSnapshotV1 | undefined> } {
  const [snapshot, setSnapshot] = useState<PiagentWebUICanonicalSnapshotV1>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [events, setEvents] = useState<RuntimeStreamEvent[]>([]);
  const refreshSnapshot = useCallback(async () => {
    try { const next = await readSnapshot(); setSnapshot(next); setConnection("connected"); return next; }
    catch { setConnection("reconnecting"); return undefined; }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | undefined;
    let refreshTimer: number | undefined;
    let stopped = false;

    const refresh = async (markConnected = true) => {
      try {
        const next = await readSnapshot(controller.signal);
        if (!stopped) {
          setSnapshot(next);
          if (markConnected) setConnection("connected");
        }
        return next;
      } catch {
        if (!stopped && !controller.signal.aborted) setConnection("reconnecting");
        return undefined;
      }
    };
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void refresh(); }, 80);
    };
    const connect = (cursor: string | null) => {
      stream?.close();
      const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
      stream = new EventSource(`/api/v1/events${query}`, { withCredentials: true });
      stream.onopen = () => { if (!stopped) setConnection("connected"); };
      stream.addEventListener("runtime-event", (raw) => {
        try {
          const value = JSON.parse((raw as MessageEvent).data) as RuntimeStreamEvent;
          if (value && typeof value.kind === "string") setEvents((current) => [...current, value].slice(-500));
          if (!["message.text-delta", "message.thinking-state", "activity.progress"].includes(String(value.kind))) scheduleRefresh();
        } catch { /* malformed events are ignored; transport resync remains authoritative */ }
      });
      stream.addEventListener("resync-required", () => { void (async () => {
        stream?.close();
        setEvents([]);
        if (!stopped) setConnection("reconnecting");
        const next = await refresh(false);
        if (next && !stopped) connect(next.revision.eventCursor);
      })(); });
      stream.onerror = () => { if (!stopped) setConnection("reconnecting"); };
    };

    void (async () => {
      const bootstrap = await bootstrapBrowserSession();
      if (stopped) return;
      if (bootstrap === "failed") { setConnection("failed"); return; }
      const initial = await refresh();
      if (!initial || stopped) { setConnection("failed"); return; }
      connect(initial.revision.eventCursor);
    })();

    return () => {
      stopped = true;
      controller.abort();
      stream?.close();
      window.clearTimeout(refreshTimer);
    };
  }, []);

  return { snapshot, connection, events, refreshSnapshot };
}
