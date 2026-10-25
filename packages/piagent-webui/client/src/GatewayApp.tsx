import { SessionHubApp } from "./SessionHubApp.tsx";
import { UpdateProvider } from "./update-state.tsx";
import { useSessionHub } from "./use-session-hub.ts";

import { useUiPreferences } from "./ui-preferences.tsx";
import { useServerPreferences } from "./use-server-preferences.ts";

export default function GatewayApp() {
  const state = useSessionHub(), { locale, themeId, setLocale, setThemeId } = useUiPreferences();
  useServerPreferences(Boolean(state.catalog), { locale, themeId }, { setLocale, setThemeId });
  return <UpdateProvider><SessionHubApp {...state} /></UpdateProvider>;
}
