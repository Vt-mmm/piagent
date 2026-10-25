import { lazy, StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";

import { AsyncSurface } from "./AsyncSurface.tsx";
import { createPiagentTheme } from "./theme.ts";
import { DEFAULT_THEME, THEME_PRESETS, themePreset } from "./theme-presets.ts";
import { preferredLocale } from "./locale-preference.ts";
import { UiPreferencesProvider, type UiColorMode, type UiLocale } from "./ui-preferences.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Piagent WebUI root is missing");
const cspNonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
const emotionCache = createCache({
  key: "piagent-mui",
  nonce: cspNonce && !cspNonce.startsWith("__PIAGENT_") ? cspNonce : undefined,
  prepend: true
});

const InspectionApp = lazy(() => import("./InspectionApp.tsx"));
const GatewayApp = lazy(() => import("./GatewayApp.tsx"));

function storedPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = window.localStorage.getItem(key) as T | null; return value && allowed.includes(value) ? value : fallback; }
  catch { return fallback; }
}

function PiagentUiRoot() {
  const [locale, setLocale] = useState<UiLocale>(() => storedPreference("piagent-webui-locale", ["vi", "en"], preferredLocale(window.navigator?.languages ?? [window.navigator?.language ?? ""])));
  const [themeId, setThemeId] = useState<string>(() => {
    const stored = storedPreference("piagent-webui-theme", THEME_PRESETS.map(item => item.id), "");
    return stored || DEFAULT_THEME[storedPreference<UiColorMode>("piagent-webui-color-mode", ["light", "dark"],
      window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")];
  });
  const preset = themePreset(themeId) ?? themePreset(DEFAULT_THEME.dark)!, colorMode: UiColorMode = preset.mode;
  // Light or dark switches to that mode's default theme; a theme of the same mode is kept.
  const setColorMode = useCallback((mode: UiColorMode) => setThemeId(current => themePreset(current)?.mode === mode ? current : DEFAULT_THEME[mode]), []);
  const theme = useMemo(() => createPiagentTheme(preset), [preset]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.piagentColorMode = colorMode;
    document.documentElement.dataset.piagentTheme = preset.id;
    try {
      window.localStorage.setItem("piagent-webui-locale", locale); window.localStorage.setItem("piagent-webui-color-mode", colorMode);
      window.localStorage.setItem("piagent-webui-theme", preset.id);
    } catch { /* local preference is best-effort */ }
  }, [colorMode, locale, preset]);
  const preferences = useMemo(() => ({ locale, colorMode, themeId: preset.id, setLocale, setColorMode, setThemeId }), [colorMode, locale, preset, setColorMode]);
  const mode = document.querySelector<HTMLMetaElement>('meta[name="piagent-webui-mode"]')?.content;
  return <UiPreferencesProvider value={preferences}><ThemeProvider theme={theme}><CssBaseline /><AsyncSurface locale={locale}>{mode === "gateway" ? <GatewayApp /> : <InspectionApp />}</AsyncSurface></ThemeProvider></UiPreferencesProvider>;
}

createRoot(root).render(
  <StrictMode>
    <CacheProvider value={emotionCache}>
      <PiagentUiRoot />
    </CacheProvider>
  </StrictMode>
);
