import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import AutoAwesomeOutlined from "@mui/icons-material/AutoAwesomeOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import TerminalRounded from "@mui/icons-material/TerminalRounded";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Popper from "@mui/material/Popper";
import Typography from "@mui/material/Typography";

import { readPathSuggestions, readProjectCommands, type AgentCommand } from "./api.ts";
import { applyCommand, applyMention, commandAt, mentionAt, type Mention } from "./path-mention.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// What a composer offers while the member types, as in Pi's terminal:
// - @: the files and folders of the conversation's project, and after ~/ or
//   / any folder on this Mac; picking one writes @path, which the agent reads;
// - / at the start of the message: the project's and the member's commands
//   (/name) and skills (/skill:name), those kept for other coding agents too.
type Item = { key: string; label: string; hint: string | null; detail: string; icon: "file" | "directory" | "command" | "skill";
  apply(text: string, at: Mention): { text: string; caret: number } };
const LIMIT = 20;
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function commandItems(commands: AgentCommand[], query: string, locale: UiLocale): Item[] {
  const wanted = fold(query.replace(/^skill:/, ""));
  const rank = (command: AgentCommand) => fold(command.name).startsWith(wanted) ? 0 : fold(command.name).includes(wanted) ? 1
    : fold(command.description).includes(wanted) ? 2 : 3;
  const where = (command: AgentCommand) => `${command.scope === "user" ? "~/" : ""}.${command.origin === "pi" ? "pi" : command.origin}`;
  return commands.filter((command) => rank(command) < 3 && (!query.startsWith("skill:") || command.kind === "skill"))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, LIMIT)
    .map((command) => ({ key: `${command.kind}:${command.name}`, icon: command.kind,
      label: command.kind === "skill" ? `/skill:${command.name}` : `/${command.name}`, hint: command.argumentHint,
      detail: `${command.description}${command.description ? " · " : ""}${command.kind === "skill" ? "skill" : localize(locale, "lệnh", "command")} ${where(command)}`,
      apply: (text, at) => applyCommand(text, at, command) }));
}

export function useComposerSuggestions({ projectRef, value, onChange, locale }: { projectRef: string | null | undefined; value: string;
  onChange(value: string): void; locale: UiLocale }): {
  inputRef: React.RefObject<HTMLTextAreaElement | null>; menu: ReactNode; onKeyDown(event: KeyboardEvent): boolean;
  // The caret, after every change and move; focus opens and closes the menu.
  track(event: SyntheticEvent): void; inputProps: { onFocus(): void; onBlur(): void };
  htmlInput: { onSelect(event: SyntheticEvent): void } & Record<string, unknown>;
} {
  const inputRef = useRef<HTMLTextAreaElement | null>(null), listId = useId();
  const [caret, setCaret] = useState<number | null>(null), [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null), [active, setActive] = useState(0);
  const [paths, setPaths] = useState<{ query: string; items: Item[] } | null>(null);
  const [commands, setCommands] = useState<{ projectRef: string; list: AgentCommand[] } | null>(null);
  const at = projectRef && caret !== null && caret <= value.length ? caret : null;
  const command = at === null ? null : commandAt(value, at);
  const mention = at === null || command ? null : mentionAt(value, at);
  const current = command ?? mention, mode = command ? "command" : "path";
  const live = current && `${mode}:${current.start}` !== dismissed ? current : null;
  const pathQuery = live && mode === "path" ? live.query : null;
  useEffect(() => {
    if (pathQuery === null || !projectRef) { setPaths(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readPathSuggestions(projectRef, pathQuery, controller.signal)
        .then((answer) => {
          setPaths({ query: pathQuery, items: answer.suggestions.map((item) => ({ key: item.value, label: item.label, hint: null, icon: item.kind,
            detail: item.detail.slice(0, Math.max(0, item.detail.length - item.label.replace(/\/$/, "").length)),
            apply: (text: string, mentionNow: Mention) => applyMention(text, mentionNow, item) })) });
          setActive(0);
        })
        .catch(() => { if (!controller.signal.aborted) setPaths({ query: pathQuery, items: [] }); });
    }, 90);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectRef, pathQuery]);
  // Commands are read once per project, when the member first types a /.
  const wantsCommands = Boolean(live && mode === "command" && projectRef && commands?.projectRef !== projectRef);
  useEffect(() => {
    if (!wantsCommands || !projectRef) return;
    const controller = new AbortController();
    readProjectCommands(projectRef, controller.signal).then((answer) => setCommands({ projectRef, list: answer.commands }))
      .catch(() => { if (!controller.signal.aborted) setCommands({ projectRef, list: [] }); });
    return () => controller.abort();
  }, [wantsCommands, projectRef]);
  const items = !live ? null : mode === "path" ? paths?.items ?? null
    : commands && commands.projectRef === projectRef ? commandItems(commands.list, live.query, locale) : null;
  useEffect(() => { setActive(0); }, [mode, live?.query]);
  const open = Boolean(focused && live && items && inputRef.current);
  const suggestions = open ? items! : [];
  useEffect(() => { if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [open, active, listId]);

  const pick = (item: Item) => {
    if (!live) return;
    const next = item.apply(value, live);
    onChange(next.text); setCaret(next.caret);
    // React writing the new text moves the caret to its end (past a closing
    // quote); a late selection event would then close the menu. The caret is
    // put back, and recorded again, once the text is on screen.
    requestAnimationFrame(() => {
      const input = inputRef.current; if (!input) return;
      input.focus(); input.setSelectionRange(next.caret, next.caret); setCaret(next.caret);
    });
  };
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(`${mode}:${live!.start}`); return true; }
    if (!suggestions.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); pick(suggestions[Math.min(active, suggestions.length - 1)]); return true;
    }
    return false;
  };
  const icon = (kind: Item["icon"]) => kind === "directory" ? <FolderOutlined fontSize="small" color="primary" />
    : kind === "file" ? <DescriptionOutlined fontSize="small" color="action" />
      : kind === "skill" ? <AutoAwesomeOutlined fontSize="small" color="secondary" /> : <TerminalRounded fontSize="small" color="primary" />;
  const title = mode === "command" ? localize(locale, "Lệnh và skill", "Commands and skills") : localize(locale, "File và folder", "Files and folders");
  const anchor = inputRef.current;
  const menu = <Popper open={open} anchorEl={anchor} placement="top-start" disablePortal sx={{ zIndex: 1350, width: Math.min(640, anchor?.clientWidth ?? 640) }}
    modifiers={[{ name: "offset", options: { offset: [0, 10] } }]}>
    <Paper elevation={8} sx={{ borderRadius: 2, overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: 340 }}>
      <Typography variant="caption" color="text.secondary" sx={{ px: 1.5, pt: 1, pb: .5 }}>
        {mode === "command"
          ? localize(locale, "Lệnh và skill của project và trên máy này · Tab để chọn", "Commands and skills of the project and on this computer · Tab to pick")
          : localize(locale, "File và folder · gõ ~/ hoặc / để chọn folder khác trên máy · Tab để chọn",
            "Files and folders · type ~/ or / for other folders on this computer · Tab to pick")}</Typography>
      {suggestions.length ? <Box component="ul" role="listbox" id={listId} aria-label={title}
        sx={{ listStyle: "none", m: 0, p: .5, pt: 0, overflowY: "auto" }}>
        {suggestions.map((item, index) => <Box component="li" key={item.key} id={`${listId}-${index}`} role="option" aria-selected={index === active}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(item)}
          sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, px: 1, py: .55, borderRadius: 1.5, cursor: "pointer",
            bgcolor: index === active ? "action.selected" : "transparent" }}>
          {icon(item.icon)}
          <Typography noWrap sx={{ flexShrink: 0, maxWidth: "55%", fontSize: 14, fontWeight: 600 }}>{item.label}</Typography>
          {item.hint && <Typography noWrap variant="caption" sx={{ flexShrink: 0, maxWidth: "25%", fontFamily: "monospace" }}>{item.hint}</Typography>}
          <Typography noWrap variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>{item.detail}</Typography>
        </Box>)}
      </Box> : <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, pb: 1.25 }}>
        {mode === "command" ? localize(locale, "Không có lệnh hoặc skill khớp", "No matching command or skill")
          : localize(locale, "Không có file hoặc folder khớp", "No matching file or folder")}</Typography>}
    </Paper>
  </Popper>;
  const track = (event: SyntheticEvent) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? null);
  return {
    inputRef, menu, onKeyDown, track,
    inputProps: { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
    htmlInput: { onSelect: track, "aria-autocomplete": "list", "aria-controls": open && suggestions.length ? listId : undefined,
      "aria-activedescendant": open && suggestions.length ? `${listId}-${active}` : undefined }
  };
}
