import { useEffect, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import type { PiagentWebUIWorkspaceTreeV1 } from "../../contracts/generated/workspace-tree-v1.ts";
import { readWorkspaceTree } from "./workspace-api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

type Listing = PiagentWebUIWorkspaceTreeV1 | "loading" | "error";
const parents = (path: string) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));

// Folders open in place, as in VS Code: each folder is read when first
// expanded and read again on refresh while it stays open.
export function WorkspaceFileTree({ sessionRef, refresh, active, onOpen, onFolder }: { sessionRef: string; refresh: number; active?: string; onOpen(path: string): void; onFolder(path: string): void }) {
  const { locale } = useUiPreferences();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [listings, setListings] = useState<Map<string, Listing>>(() => new Map());
  const [selected, setSelected] = useState<string>();
  const load = (folder: string, signal?: AbortSignal) => {
    setListings(current => new Map(current).set(folder, current.get(folder) ?? "loading"));
    void readWorkspaceTree(sessionRef, folder, signal).then(value => { if (!signal?.aborted) setListings(current => new Map(current).set(folder, value)); })
      .catch(() => { if (!signal?.aborted) setListings(current => new Map(current).set(folder, "error")); });
  };
  useEffect(() => { setListings(new Map()); setExpanded(new Set([""])); }, [sessionRef]);
  useEffect(() => {
    const controller = new AbortController();
    for (const folder of expanded) load(folder, controller.signal);
    return () => controller.abort();
  }, [sessionRef, refresh]);
  // The file opened from elsewhere (search, a link, Cmd+P) is shown in its folder.
  useEffect(() => {
    if (!active) return;
    const missing = parents(active).filter(folder => !expanded.has(folder));
    if (!missing.length) return;
    setExpanded(current => new Set([...current, ...missing]));
    for (const folder of missing) if (!listings.has(folder)) load(folder);
  }, [active]);
  const toggle = (folder: string) => {
    setSelected(folder); onFolder(folder);
    if (expanded.has(folder)) { setExpanded(current => { const next = new Set(current); next.delete(folder); return next; }); return; }
    setExpanded(current => new Set(current).add(folder));
    if (!listings.has(folder) || listings.get(folder) === "error") load(folder);
  };
  const rows = (folder: string, depth: number): ReactNode => {
    const listing = listings.get(folder);
    if (!listing || listing === "loading") return <CircularProgress size={14} sx={{ ml: 1.5 + depth * 1.5, my: 0.5 }} />;
    if (listing === "error") return <Typography variant="caption" color="warning.main" sx={{ pl: 1.5 + depth * 1.5 }}>{localize(locale, "Chưa đọc được thư mục này.", "This folder could not be read.")}</Typography>;
    return <>
      {listing.entries.map(entry => {
        const directory = entry.kind === "directory", open = directory && expanded.has(entry.path);
        const current = directory ? selected === entry.path : active === entry.path;
        const icon = directory ? <>{open ? <ExpandMoreIcon sx={{ fontSize: 16 }} /> : <ChevronRightIcon sx={{ fontSize: 16 }} />}
          {open ? <FolderOpenOutlinedIcon sx={{ fontSize: 16 }} /> : <FolderOutlinedIcon sx={{ fontSize: 16 }} />}</>
          : <InsertDriveFileOutlinedIcon sx={{ fontSize: 16, ml: "16px" }} />;
        return <Box key={entry.path}>
          <Button fullWidth size="small" disabled={entry.protected || entry.kind === "symlink" || entry.kind === "other"}
            aria-label={entry.protected ? `${entry.name} (${localize(locale, "được bảo vệ", "protected")})` : entry.name}
            aria-expanded={directory ? open : undefined} aria-current={!directory && active === entry.path ? "true" : undefined}
            onClick={() => directory ? toggle(entry.path) : (setSelected(undefined), onOpen(entry.path))}
            sx={{ justifyContent: "flex-start", textTransform: "none", gap: 0.5, minHeight: 24, py: 0, pl: 0.5 + depth * 1.5, pr: 1,
              color: "text.primary", fontWeight: 400, whiteSpace: "nowrap", bgcolor: current ? "action.selected" : undefined }}>
            {icon}<Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}{entry.protected ? " 🔒" : ""}</Box>
          </Button>
          {open && rows(entry.path, depth + 1)}
        </Box>;
      })}
      {listing.truncated && <Typography variant="caption" sx={{ pl: 1.5 + depth * 1.5 }}>{localize(locale, "Danh sách đã được giới hạn.", "Listing limit reached.")}</Typography>}
    </>;
  };
  return <Box role="group" aria-label={localize(locale, "Cây thư mục", "Folder tree")} sx={{ py: 0.5 }}>{rows("", 0)}</Box>;
}
