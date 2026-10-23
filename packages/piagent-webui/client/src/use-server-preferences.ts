import { useEffect, useRef } from "react";
import { browserCsrfToken, csrfFetch } from "./bootstrap.ts";
import { themePreset } from "./theme-presets.ts";
import type { UiLocale } from "./locale-preference.ts";

type Stored = { locale?: UiLocale; themeId?: string };

async function readStored(): Promise<Stored | null> {
  const response = await fetch("/api/v1/preferences", { credentials: "same-origin", headers: { Accept: "application/json" } });
  return response.ok ? await response.json() as Stored : null;
}

async function saveStored(value: Stored): Promise<void> {
  const csrf = browserCsrfToken(); if (!csrf) return;
  await csrfFetch("/api/v1/preferences", { method: "POST", credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(value) });
}

// The browser keeps the language and theme per origin, and the dashboard's
// port changes with each start; the Gateway keeps them across restarts. Once
// the browser session is ready, the stored choice is applied (or this
// browser's is stored, the first time); every later change is stored.
export function useServerPreferences(ready: boolean, current: { locale: UiLocale; themeId: string },
  apply: { setLocale(locale: UiLocale): void; setThemeId(id: string): void }) {
  const loaded = useRef(false), latest = useRef(current); latest.current = current;
  useEffect(() => {
    if (!ready || loaded.current) return;
    let cancelled = false;
    void readStored().then(stored => {
      if (cancelled || !stored) return;
      loaded.current = true;
      if (stored.locale) apply.setLocale(stored.locale);
      if (stored.themeId && themePreset(stored.themeId)) apply.setThemeId(stored.themeId);
      if (!stored.locale || !stored.themeId) void saveStored({ ...latest.current, ...stored }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [ready]);
  useEffect(() => { if (loaded.current) void saveStored(current).catch(() => {}); }, [current.locale, current.themeId]);
}
