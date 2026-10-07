export type BootstrapState = "authenticated" | "existing-session" | "failed";
let csrfToken: string | null = null;
let bootstrapPromise: Promise<BootstrapState> | null = null;

async function captureSession(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const value = await response.json() as { csrfToken?: unknown };
    if (typeof value.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken)) return false;
    csrfToken = value.csrfToken; return true;
  } catch { return false; }
}

export function browserCsrfToken(): string | null { return csrfToken; }

// A launch in another tab of this browser replaces the session cookie, and
// with it the token this tab holds: a refused change re-reads the session of
// the cookie once and is sent again when the token was indeed replaced.
export async function csrfFetch(input: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 403) return response;
  const sent = init.headers["X-Piagent-CSRF"];
  try { await captureSession(await fetch("/api/v1/browser-session", { credentials: "same-origin", headers: { Accept: "application/json" }, signal: init.signal })); }
  catch { return response; }
  if (!csrfToken || csrfToken === sent) return response;
  return fetch(input, { ...init, headers: { ...init.headers, "X-Piagent-CSRF": csrfToken } });
}

// A launcher (Agent Watch's WebUI button) names the project it opened for.
let launchProject: string | null = null;
export function launchProjectRef(): string | null { return launchProject; }

async function performBootstrap(): Promise<BootstrapState> {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const capability = parameters.get("bootstrap"), project = parameters.get("project");
  if (project && /^[A-Za-z0-9_-]{1,120}$/.test(project)) launchProject = project;
  if (!capability) {
    if (project) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    try {
      const response = await fetch("/api/v1/browser-session", { credentials: "same-origin", headers: { Accept: "application/json" } });
      return await captureSession(response) ? "existing-session" : "failed";
    } catch { return "failed"; }
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  try {
    const response = await fetch("/api/v1/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability })
    });
    return await captureSession(response) ? "authenticated" : "failed";
  } catch {
    return "failed";
  }
}

export function bootstrapBrowserSession(): Promise<BootstrapState> {
  bootstrapPromise ??= performBootstrap();
  return bootstrapPromise;
}

// Browser sessions live in the Gateway's memory: a restart, the 8-hour expiry
// or an older launch of another local server leaves this tab without one, and
// only a new launch link can sign it in again. A refused read is confirmed
// against the session endpoint once, then every poll stops and the page says so.
let sessionLost = false, lostCheck: Promise<void> | null = null;
const lostListeners = new Set<() => void>();
export function browserSessionLost(): boolean { return sessionLost; }
export function subscribeSessionLost(listener: () => void): () => void {
  lostListeners.add(listener); return () => { lostListeners.delete(listener); };
}
export function noteUnauthorized(): void {
  if (sessionLost || lostCheck) return;
  lostCheck = (async () => {
    try {
      await bootstrapBrowserSession();
      const response = await fetch("/api/v1/browser-session", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (response.status !== 401) { await captureSession(response); return; }
      sessionLost = true;
      for (const listener of lostListeners) listener();
    } catch { /* the Gateway is unreachable; reconnect owns that */ }
    finally { lostCheck = null; }
  })();
}
