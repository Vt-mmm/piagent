import { useMemo, useState } from "react";
import AccountTreeRounded from "@mui/icons-material/AccountTreeRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import HubRounded from "@mui/icons-material/HubRounded";
import InfoOutlined from "@mui/icons-material/InfoOutlined";
import KeyboardRounded from "@mui/icons-material/KeyboardRounded";
import MemoryRounded from "@mui/icons-material/MemoryRounded";
import PsychologyRounded from "@mui/icons-material/PsychologyRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import SecurityRounded from "@mui/icons-material/SecurityRounded";
import SystemUpdateAltRounded from "@mui/icons-material/SystemUpdateAltRounded";
import TuneRounded from "@mui/icons-material/TuneRounded";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { matchesWords } from "./CommandPalette.tsx";
import { modifierKey } from "./StatusBar.tsx";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";
import { useUpdates } from "./update-state.tsx";

export type SettingsSection = "general" | "updates" | "shortcuts" | "models" | "controls" | "connections" | "permissions" | "usage" | "about";

type Entry = { id: SettingsSection; group: string; label: string; icon: React.ReactNode; keywords: string };

// Every section with the words a member may look for (both languages), so
// searching finds a setting by what it does, not only by its section name.
export function settingsEntries(locale: UiLocale): Entry[] {
  const general = localize(locale, "Chung", "General"), agent = "Agent", tools = localize(locale, "Công cụ", "Tools"), info = localize(locale, "Thông tin", "Information");
  return [
    { id: "general", group: general, label: localize(locale, "Giao diện", "Appearance"), icon: <TuneRounded />, keywords: "ngôn ngữ language chủ đề theme sáng tối light dark tiếng việt english" },
    { id: "updates", group: general, label: localize(locale, "Cập nhật", "Updates"), icon: <SystemUpdateAltRounded />, keywords: "update phiên bản version pi piagent npm nâng cấp upgrade" },
    { id: "shortcuts", group: general, label: localize(locale, "Phím tắt", "Shortcuts"), icon: <KeyboardRounded />, keywords: "keyboard bàn phím shortcut lệnh command palette enter" },
    { id: "models", group: agent, label: localize(locale, "Nhà cung cấp & model", "Providers & models"), icon: <PsychologyRounded />, keywords: "model provider thinking đăng nhập login oauth tài khoản account công ty company" },
    { id: "controls", group: agent, label: localize(locale, "Điều khiển project", "Project controls"), icon: <AccountTreeRounded />, keywords: "project runtime khởi động lại restart session" },
    { id: "permissions", group: agent, label: localize(locale, "Quyền truy cập", "Access"), icon: <SecurityRounded />, keywords: "permission quyền sandbox đọc ghi read write network mạng" },
    { id: "connections", group: tools, label: localize(locale, "MCP & kết nối", "MCP & connections"), icon: <HubRounded />, keywords: "mcp server tool công cụ oauth kết nối connection" },
    { id: "usage", group: info, label: localize(locale, "Sử dụng & context", "Usage & context"), icon: <MemoryRounded />, keywords: "token usage context ngữ cảnh input output" },
    { id: "about", group: info, label: "Piagent", icon: <InfoOutlined />, keywords: "gateway protocol runtime giới thiệu about" }
  ];
}

export function matchSettings(entries: Entry[], query: string): Entry[] {
  return query.trim() ? entries.filter((entry) => matchesWords(`${entry.label} ${entry.group} ${entry.keywords}`, query)) : entries;
}

export function SettingsNavigation({ section, onSection, onBack }: { section: SettingsSection; onSection(value: SettingsSection): void; onBack(): void }) {
  const { locale } = useUiPreferences();
  const { status } = useUpdates();
  const [query, setQuery] = useState("");
  const entries = useMemo(() => matchSettings(settingsEntries(locale), query), [locale, query]);
  const updateDot = Boolean(status?.updateAvailable && status.installable);
  let previousGroup = "";
  return <Box component="nav" aria-label={localize(locale, "Mục cài đặt", "Settings sections")} sx={{ borderRight: { sm: 1 }, borderBottom: { xs: 1, sm: 0 },
    borderColor: "divider", bgcolor: "background.paper", p: 1.25, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
    <Stack direction="row" sx={{ minHeight: 48, alignItems: "center", justifyContent: "space-between", px: 1 }}>
      <Typography id="piagent-settings-title" sx={{ fontWeight: 700 }}>{localize(locale, "Cài đặt", "Settings")}</Typography>
      <IconButton aria-label={localize(locale, "Đóng cài đặt", "Close settings")} onClick={onBack}><CloseRounded /></IconButton></Stack>
    <Paper variant="outlined" sx={{ display: "flex", alignItems: "center", gap: .75, px: 1, mx: .5, mb: 1, borderRadius: 1.5 }}>
      <SearchRounded fontSize="small" color="action" />
      <InputBase value={query} onChange={(event) => setQuery(event.target.value)} placeholder={localize(locale, "Tìm cài đặt", "Search settings")}
        inputProps={{ "aria-label": localize(locale, "Tìm cài đặt", "Search settings") }}
        onKeyDown={(event) => { if (event.key === "Enter" && entries[0]) { event.preventDefault(); onSection(entries[0].id); } }}
        sx={{ flex: 1, fontSize: 13, py: .5 }} /></Paper>
    <List component="div" disablePadding sx={{ display: { xs: "flex", sm: "block" }, minWidth: { xs: "max-content", sm: 0 }, overflowX: "auto", flex: 1 }}>
      {entries.map((entry) => {
        const header = entry.group !== previousGroup ? entry.group : null; previousGroup = entry.group;
        return <Box key={entry.id} sx={{ display: { xs: "contents", sm: "block" } }}>
          {header && <ListSubheader component="div" disableSticky sx={{ display: { xs: "none", sm: "block" }, bgcolor: "transparent", lineHeight: "30px", fontSize: 11,
            fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", mt: .5 }}>{header}</ListSubheader>}
          <ListItemButton selected={section === entry.id} onClick={() => onSection(entry.id)}>
            <ListItemIcon sx={{ minWidth: 36, color: "inherit", "& .MuiSvgIcon-root": { fontSize: 19 } }}>{entry.icon}</ListItemIcon>
            <ListItemText primary={entry.label} slotProps={{ primary: { sx: { fontSize: 13, fontWeight: section === entry.id ? 800 : 650 } } }} />
            {entry.id === "updates" && updateDot && <Box aria-label={localize(locale, "Có bản cập nhật", "Update available")} role="img"
              sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main", flexShrink: 0 }} />}</ListItemButton></Box>;
      })}
      {!entries.length && <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 2 }}>{localize(locale, "Không có mục nào khớp.", "No matching setting.")}</Typography>}
    </List>
    {status?.piagent.installed && <Typography variant="caption" color="text.disabled" sx={{ display: { xs: "none", sm: "block" }, px: 1.5, pt: 1 }}>
      {`Piagent ${status.piagent.installed}${status.pi.installed ? ` · Pi ${status.pi.installed}` : ""}`}</Typography>}
  </Box>;
}

export function ShortcutSettings() {
  const { locale } = useUiPreferences(), mod = modifierKey();
  const rows: [string, string][] = [
    [`${mod} K`, localize(locale, "Mở bảng lệnh: mọi thao tác và cuộc trò chuyện theo tên", "Open the command palette: every action and conversation by name")],
    [`${mod} ,`, localize(locale, "Mở Cài đặt", "Open Settings")],
    ["Enter", localize(locale, "Gửi tin nhắn", "Send the message")],
    ["Shift Enter", localize(locale, "Xuống dòng trong tin nhắn", "New line in the message")],
    ["1 – 5", localize(locale, "Chọn đáp án khi main agent hỏi; Enter để gửi câu trả lời", "Pick an answer when the main agent asks; Enter sends it")],
    ["Esc", localize(locale, "Đóng hộp thoại hoặc bảng lệnh", "Close a dialog or the palette")]];
  return <><Typography component="h1" variant="h1" sx={{ mb: 3 }}>{localize(locale, "Phím tắt", "Shortcuts")}</Typography>
    <Paper variant="outlined" sx={{ borderRadius: 2.5, overflow: "hidden" }}>{rows.map(([keys, text], index) => <Stack key={keys} direction="row"
      sx={{ px: 2.25, py: 1.5, gap: 2, alignItems: "center", justifyContent: "space-between", borderTop: index ? 1 : 0, borderColor: "divider" }}>
      <Typography>{text}</Typography><Box component="kbd" sx={{ px: .9, py: .2, border: 1, borderColor: "divider", borderRadius: 1, fontSize: 12, fontFamily: "inherit",
        whiteSpace: "nowrap", bgcolor: "action.hover" }}>{keys}</Box></Stack>)}</Paper></>;
}
