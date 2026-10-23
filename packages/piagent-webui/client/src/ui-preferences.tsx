import { createContext, useContext, type ReactNode } from "react";

export type { UiLocale } from "./locale-preference.ts";
import type { UiLocale } from "./locale-preference.ts";
import { DEFAULT_THEME, themePreset, type ThemePreset } from "./theme-presets.ts";
export type UiColorMode = "light" | "dark";

export type UiPreferences = {
  locale: UiLocale;
  colorMode: UiColorMode;
  // A preset from theme-presets.ts; colorMode is the preset's mode.
  themeId: string;
  setLocale(locale: UiLocale): void;
  setColorMode(mode: UiColorMode): void;
  setThemeId(id: string): void;
};

const UiPreferencesContext = createContext<UiPreferences | null>(null);

export function UiPreferencesProvider({ value, children }: { value: UiPreferences; children: ReactNode }) {
  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferences {
  const value = useContext(UiPreferencesContext);
  if (!value) throw new Error("Piagent UI preferences are missing");
  return value;
}

export function useThemePreset(): ThemePreset {
  const { themeId, colorMode } = useUiPreferences();
  return themePreset(themeId) ?? themePreset(DEFAULT_THEME[colorMode])!;
}

export function localize(locale: UiLocale, vi: string, en: string): string {
  return locale === "vi" ? vi : en;
}
