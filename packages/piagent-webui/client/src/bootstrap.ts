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
