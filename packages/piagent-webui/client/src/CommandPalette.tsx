import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import SearchRounded from "@mui/icons-material/SearchRounded";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import InputBase from "@mui/material/InputBase";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListSubheader from "@mui/material/ListSubheader";
import Typography from "@mui/material/Typography";

import { localize, type UiLocale } from "./ui-preferences.tsx";

// The command palette (⌘K / Ctrl+K): every action of the dashboard, and the
// conversations, by name. Matching ignores case and Vietnamese accents.
export type PaletteCommand = { id: string; group: string; label: string; hint?: string; keywords?: string; run(): void };

export const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

// Each typed word must start a word of the text: "chu de" finds "Chủ đề",
// not "Chung" + "update".
export function matchesWords(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean), tokens = fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.every((word) => tokens.some((token) => token.startsWith(word)));
}

export function matchCommands(commands: PaletteCommand[], query: string, limit = 40): PaletteCommand[] {
  if (!query.trim()) return commands.slice(0, limit);
  return commands.filter((command) => matchesWords(`${command.label} ${command.keywords ?? ""} ${command.group}`, query)).slice(0, limit);
}

// ⌘K opens the palette and ⌘, opens Settings, from anywhere in the page.
export function useDashboardShortcuts(actions: { palette(): void; settings(): void }) {
  const latest = useRef(actions); latest.current = actions;
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); latest.current.palette(); }
      else if (event.key === ",") { event.preventDefault(); latest.current.settings(); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

export function CommandPalette({ open, onClose, commands, locale }: { open: boolean; onClose(): void; commands: PaletteCommand[]; locale: UiLocale }) {
  const [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const shown = useMemo(() => matchCommands(commands, query), [commands, query]);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const run = (command: PaletteCommand | undefined) => { if (!command) return; onClose(); setTimeout(() => command.run(), 0); };
  const keys = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((n) => Math.min(n + 1, shown.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((n) => Math.max(n - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); run(shown[active]); }
  };
  let previousGroup = "";
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm"
    slotProps={{ paper: { "aria-label": localize(locale, "Bảng lệnh", "Command palette"),
      sx: { alignSelf: "flex-start", mt: { xs: 2, sm: "12vh" }, borderRadius: 2.5, overflow: "hidden" } } }}>
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
      <SearchRounded fontSize="small" color="action" />
      <InputBase autoFocus fullWidth value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={keys}
        placeholder={localize(locale, "Gõ lệnh hoặc tên cuộc trò chuyện…", "Type a command or a conversation name…")}
        inputProps={{ role: "combobox", "aria-expanded": true, "aria-controls": "piagent-palette-list", "aria-activedescendant": shown[active] ? `palette-${shown[active].id}` : undefined,
          "aria-label": localize(locale, "Tìm lệnh", "Search commands") }} /></Box>
    <List component="div" id="piagent-palette-list" role="listbox" aria-label={localize(locale, "Lệnh", "Commands")} ref={listRef} dense sx={{ maxHeight: "min(60vh, 460px)", overflowY: "auto", py: .5 }}>
      {shown.map((command, index) => {
        const header = command.group !== previousGroup ? command.group : null; previousGroup = command.group;
        // Group names are visual; each option is named by its own label.
        return <Fragment key={command.id}>{header && <ListSubheader component="div" aria-hidden disableSticky sx={{ lineHeight: "28px", fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase" }}>{header}</ListSubheader>}
          <ListItemButton id={`palette-${command.id}`} role="option" aria-selected={index === active} data-index={index} selected={index === active}
            onMouseMove={() => setActive(index)} onClick={() => run(command)} sx={{ mx: .5, borderRadius: 1.5, gap: 2 }}>
            <Typography sx={{ flex: 1, minWidth: 0, fontSize: 14 }} noWrap>{command.label}</Typography>
            {command.hint && <Typography variant="caption" color="text.secondary" noWrap>{command.hint}</Typography>}</ListItemButton></Fragment>;
      })}
      {!shown.length && <Typography sx={{ px: 2.5, py: 3 }} color="text.secondary">{localize(locale, "Không có lệnh nào khớp.", "No matching command.")}</Typography>}
    </List>
  </Dialog>;
}
