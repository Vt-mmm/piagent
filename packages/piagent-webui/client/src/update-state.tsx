import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { bootstrapBrowserSession, browserCsrfToken, csrfFetch } from "./bootstrap.ts";

// Piagent's own updates, as the dashboard sees them: one poll shared by the
// status bar, Settings and the command palette. The Gateway asks the registry
// (every 6 hours, or when the member checks now); this only reads its answer.
export type UpdateJob = { state: "starting" | "running" | "succeeded" | "failed"; from: string; to: string; startedAt: string;
  finishedAt?: string; reason?: string; installed?: string; bindingChanged?: boolean };
export type UpdateStatus = {
  installable: boolean; reason: "working-copy" | "company-runtime" | null; checkedAt: string | null; checking: boolean; checkEveryHours: number;
  piagent: { installed: string | null; latest: string | null; updateAvailable: boolean };
  pi: { installed: string | null; required: string | null; latest: string | null; updateAvailable: boolean; newerUntested: boolean };
  updateAvailable: boolean; runningConversations: number; job: UpdateJob | null;
};
export class UpdateRequestError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  if (init?.method === "POST") {
    const csrf = browserCsrfToken(); if (!csrf) throw new UpdateRequestError(403, "mutation-authority-rejected");
    response = await csrfFetch(path, { ...init, credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf } });
  } else response = await fetch(path, { ...init, credentials: "same-origin", headers: { Accept: "application/json" } });
  const value = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
  if (!response.ok) throw new UpdateRequestError(response.status, typeof value?.error?.code === "string" ? value.error.code : `request-${response.status}`);
  return value;
}
export const readUpdateStatus = (signal?: AbortSignal) => request("/api/v1/updates", { signal }) as Promise<UpdateStatus>;
export const checkForUpdates = () => request("/api/v1/updates/check", { method: "POST", body: "{}" }) as Promise<UpdateStatus>;
export const applyUpdate = (version: string) => request("/api/v1/updates/apply", { method: "POST", body: JSON.stringify({ version }) }) as Promise<{ job: UpdateJob }>;

export const updateInProgress = (status: UpdateStatus | null) => status?.job?.state === "starting" || status?.job?.state === "running";

type UpdateState = {
  status: UpdateStatus | null; supported: boolean; checking: boolean; applying: boolean; error: string | null;
  refresh(): Promise<void>; check(): Promise<void>; apply(): Promise<void>;
};
const UpdateContext = createContext<UpdateState | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null), [supported, setSupported] = useState(true);
  const [checking, setChecking] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    // The first read waits for this page's browser session, so it is not refused.
    try { await bootstrapBrowserSession(); const value = await readUpdateStatus(); if (live.current) { setStatus(value); setSupported(true); } }
    catch (failure) { if (live.current && failure instanceof UpdateRequestError && failure.status === 404) setSupported(false); }
  }, []);
  // The Gateway's answer changes rarely; a running update is followed closely,
  // and the first answer is asked for again until the browser session is ready.
  const running = updateInProgress(status), loaded = status !== null || !supported;
  useEffect(() => {
    live.current = true; void refresh();
    const timer = setInterval(() => void refresh(), !loaded ? 2_000 : running ? 3_000 : 60_000);
    return () => { clearInterval(timer); };
  }, [refresh, running, loaded]);
  useEffect(() => () => { live.current = false; }, []);
  const check = useCallback(async () => {
    setChecking(true); setError(null);
    try { setStatus(await checkForUpdates()); } catch (failure) { setError(failure instanceof Error ? failure.message : "update-unavailable"); }
    finally { setChecking(false); }
  }, []);
  const apply = useCallback(async () => {
    const version = status?.piagent.latest; if (!version) return;
    setApplying(true); setError(null);
    try { await applyUpdate(version); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "update-unavailable"); await refresh(); }
    finally { setApplying(false); }
  }, [status?.piagent.latest, refresh]);
  const value = useMemo(() => ({ status, supported, checking: checking || Boolean(status?.checking), applying, error, refresh, check, apply }),
    [status, supported, checking, applying, error, refresh, check, apply]);
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdates(): UpdateState {
  const value = useContext(UpdateContext);
  if (!value) throw new Error("Piagent update state is missing");
  return value;
}
