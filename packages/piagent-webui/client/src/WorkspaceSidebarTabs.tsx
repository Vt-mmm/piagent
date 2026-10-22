import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
export type WorkspaceSidebarMode = "sessions" | "files" | "search";
export function WorkspaceSidebarTabs({ value, onChange }: { value: WorkspaceSidebarMode; onChange(value: WorkspaceSidebarMode): void }) {
  const { locale } = useUiPreferences();
  return <Tabs value={value} onChange={(_, next) => onChange(next)} variant="fullWidth" aria-label={localize(locale, "Thanh bên", "Sidebar")}>
    <Tab value="sessions" label={localize(locale, "Phiên", "Sessions")} />
    <Tab value="files" label={localize(locale, "Tệp", "Files")} />
    <Tab value="search" label={localize(locale, "Tìm kiếm", "Search")} />
  </Tabs>;
}
