import { createContext, useContext, type ReactNode } from "react";

export type UiLocale = "vi" | "en";
export type UiColorMode = "light" | "dark";

export type UiPreferences = {
  locale: UiLocale;
  colorMode: UiColorMode;
  setLocale(locale: UiLocale): void;
  setColorMode(mode: UiColorMode): void;
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

export function localize(locale: UiLocale, vi: string, en: string): string {
  return locale === "vi" ? vi : en;
}
