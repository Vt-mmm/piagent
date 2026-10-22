import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import TextField from "@mui/material/TextField";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import Alert from "@mui/material/Alert";
import { readWorkspacePaths } from "./workspace-api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

export default function WorkspaceQuickOpen({ sessionRef, onClose, onOpen }: { sessionRef: string; onClose(): void; onOpen(path: string): void }) {
  const { locale } = useUiPreferences();
  const [query, setQuery] = useState(""), [paths, setPaths] = useState<string[]>([]), [active, setActive] = useState(0), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError(false); setPaths([]); setActive(0);
    const timer = setTimeout(() => {
      void readWorkspacePaths(sessionRef, query, controller.signal).then(result => {
        if (!controller.signal.aborted) setPaths(result.suggestions.filter(entry => entry.kind === "file").map(entry => entry.value));
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [sessionRef, query]);
  return <Dialog open onClose={onClose} fullWidth maxWidth="sm">
    <DialogTitle>{localize(locale, "Mở nhanh", "Quick open")}</DialogTitle>
    <DialogContent>
      <TextField autoFocus fullWidth value={query} label={localize(locale, "Tên tệp", "File name")} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive(value => Math.min(paths.length - 1, value + 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
          if (event.key === "Enter" && paths[active]) { event.preventDefault(); onOpen(paths[active]); }
        }} />
      {error && <Alert severity="warning">{localize(locale, "Chưa tìm được tệp.", "Files could not be searched.")}</Alert>}
      <List aria-label={localize(locale, "Tệp tìm thấy", "Matching files")}>{paths.map((path, index) =>
        <ListItemButton key={path} selected={index === active} onClick={() => onOpen(path)}>{path}</ListItemButton>)}</List>
    </DialogContent>
  </Dialog>;
}
