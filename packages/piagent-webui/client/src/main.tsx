import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";

import { App } from "./App.tsx";
import { SessionHubApp } from "./SessionHubApp.tsx";
import { createPiagentTheme } from "./theme.ts";
import { preferredLocale } from "./locale-preference.ts";
import { UiPreferencesProvider, type UiColorMode, type UiLocale } from "./ui-preferences.tsx";
import { useInspection } from "./use-inspection.ts";
import { useSessionHub } from "./use-session-hub.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Piagent WebUI root is missing");
const cspNonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
const emotionCache = createCache({
  key: "piagent-mui",
  nonce: cspNonce && !cspNonce.startsWith("__PIAGENT_") ? cspNonce : undefined,
  prepend: true
});

function InspectionApp() {
  const state = useInspection();
  return <App {...state} />;
}

function GatewayApp() {
  const state = useSessionHub();
  return <SessionHubApp {...state} />;
}

function storedPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = window.localStorage.getItem(key) as T | null; return value && allowed.includes(value) ? value : fallback; }
  catch { return fallback; }
}

function PiagentUiRoot() {
  const [locale, setLocale] = useState<UiLocale>(() => storedPreference("piagent-webui-locale", ["vi", "en"], preferredLocale(window.navigator?.languages ?? [window.navigator?.language ?? ""])));
  const [colorMode, setColorMode] = useState<UiColorMode>(() => storedPreference("piagent-webui-color-mode", ["light", "dark"],
    window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  const theme = useMemo(() => createPiagentTheme(colorMode), [colorMode]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.piagentColorMode = colorMode;
    try { window.localStorage.setItem("piagent-webui-locale", locale); window.localStorage.setItem("piagent-webui-color-mode", colorMode); } catch { /* local preference is best-effort */ }
  }, [colorMode, locale]);
  const preferences = useMemo(() => ({ locale, colorMode, setLocale, setColorMode }), [colorMode, locale]);
  const mode = document.querySelector<HTMLMetaElement>('meta[name="piagent-webui-mode"]')?.content;
  return <UiPreferencesProvider value={preferences}><ThemeProvider theme={theme}><CssBaseline />{mode === "gateway" ? <GatewayApp /> : <InspectionApp />}</ThemeProvider></UiPreferencesProvider>;
}

createRoot(root).render(
  <StrictMode>
    <CacheProvider value={emotionCache}>
      <PiagentUiRoot />
    </CacheProvider>
  </StrictMode>
);
