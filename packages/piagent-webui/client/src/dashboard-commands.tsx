import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PaletteCommand } from "./CommandPalette.tsx";
import { settingsEntries, type SettingsSection } from "./SettingsNavigation.tsx";
import { modifierKey } from "./StatusBar.tsx";
import { localize, type UiColorMode, type UiLocale } from "./ui-preferences.tsx";

// The palette's commands: the dashboard's actions first, then each settings
// section, then the conversations by name (newest first, as listed).
export function dashboardCommands(input: {
  locale: UiLocale; colorMode: UiColorMode; canCreate: boolean; hasSelection: boolean; sessions: readonly SessionRow[];
  update: { available: boolean; latest: string | null };
  actions: { newChat(): void; togglePanel(): void; openChanges(): void; refresh(): void; settings(section: SettingsSection): void;
    checkUpdates(): void; setColorMode(mode: UiColorMode): void; setLocale(locale: UiLocale): void; openSession(sessionRef: string): void };
}): PaletteCommand[] {
  const { locale, actions } = input, group = localize(locale, "Lệnh", "Commands"), mod = modifierKey();
  const commands: PaletteCommand[] = [];
  if (input.canCreate) commands.push({ id: "new-chat", group, label: localize(locale, "Cuộc trò chuyện mới", "New chat"), keywords: "new create tạo", run: actions.newChat });
  if (input.update.available && input.update.latest) commands.push({ id: "update-now", group, label: localize(locale, `Cập nhật Piagent ${input.update.latest}`, `Update Piagent ${input.update.latest}`),
    keywords: "update upgrade nâng cấp phiên bản version", run: () => actions.settings("updates") });
  commands.push({ id: "check-updates", group, label: localize(locale, "Kiểm tra cập nhật", "Check for updates"), keywords: "update version phiên bản pi piagent", run: actions.checkUpdates });
  if (input.hasSelection) commands.push(
    { id: "toggle-panel", group, label: localize(locale, "Bật/tắt khung Workspace", "Toggle the Workspace panel"), keywords: "panel sidebar changes plan context", run: actions.togglePanel },
    { id: "open-changes", group, label: localize(locale, "Mở Source Changes", "Open Source Changes"), keywords: "diff review thay đổi git", run: actions.openChanges });
  commands.push(
    { id: "theme", group, label: input.colorMode === "dark" ? localize(locale, "Chuyển sang chủ đề sáng", "Switch to the light theme") : localize(locale, "Chuyển sang chủ đề tối", "Switch to the dark theme"),
      keywords: "theme chủ đề dark light sáng tối", run: () => actions.setColorMode(input.colorMode === "dark" ? "light" : "dark") },
    { id: "language", group, label: locale === "vi" ? "Switch the interface to English" : "Chuyển giao diện sang tiếng Việt", keywords: "language ngôn ngữ english tiếng việt",
      run: () => actions.setLocale(locale === "vi" ? "en" : "vi") },
    { id: "refresh", group, label: localize(locale, "Làm mới", "Refresh"), keywords: "reload tải lại", run: actions.refresh });
  const settings = localize(locale, "Cài đặt", "Settings");
  for (const entry of settingsEntries(locale)) commands.push({ id: `settings-${entry.id}`, group: settings, label: `${settings}: ${entry.label}`,
    hint: entry.id === "general" ? `${mod} ,` : undefined, keywords: entry.keywords, run: () => actions.settings(entry.id) });
  const chats = localize(locale, "Cuộc trò chuyện", "Conversations");
  for (const session of input.sessions) commands.push({ id: `session-${session.sessionRef}`, group: chats, label: session.title,
    hint: session.projectLabel, keywords: session.projectLabel, run: () => actions.openSession(session.sessionRef) });
  return commands;
}
