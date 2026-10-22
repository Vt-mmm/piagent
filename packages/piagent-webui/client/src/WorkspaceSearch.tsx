import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { PiagentWebUIWorkspaceSearchV1 } from "../../contracts/generated/workspace-search-v1.ts";
import { searchWorkspaceContent } from "./workspace-api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

export function WorkspaceSearch({ sessionRef, onOpen }: { sessionRef: string; onOpen(path: string, line: number): void }) {
  const { locale } = useUiPreferences();
  const [query, setQuery] = useState(""), [result, setResult] = useState<PiagentWebUIWorkspaceSearchV1>();
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setResult(undefined); setError(false); setLoading(false);
    if (!query.trim()) return () => controller.abort();
    setLoading(true);
    const timer = setTimeout(() => {
      void searchWorkspaceContent(sessionRef, query, controller.signal).then(value => { if (!controller.signal.aborted) setResult(value); })
        .catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, sessionRef]);
  return <Stack spacing={1} sx={{ p: 1 }}>
    <TextField size="small" label={localize(locale, "Tìm nội dung", "Search contents")} value={query} onChange={event => setQuery(event.target.value)}
      slotProps={{ htmlInput: { maxLength: 512 } }} />
    {loading && <CircularProgress size={18} />}
    {(error || result?.available === false) && <Alert severity="warning">{localize(locale, "Chưa tìm được nội dung trong project này.", "Content search is unavailable for this project.")}</Alert>}
    {result?.available && result.backend === "fts" && <Typography variant="caption">{localize(locale, "Tìm trong các tệp đã lập chỉ mục.", "Searching indexed files.")}</Typography>}
    {result?.matches.map(match => <Button key={`${match.path}:${match.line}:${match.column}`} onClick={() => onOpen(match.path, match.line)}
      sx={{ textTransform: "none", display: "block", textAlign: "left", overflowWrap: "anywhere" }}>
      <Typography variant="caption" component="span">{match.path}:{match.line}:{match.column}</Typography>
      <Typography variant="body2" component="span" sx={{ display: "block" }}>{match.preview}</Typography>
    </Button>)}
    {result?.truncated && <Typography variant="caption">{localize(locale, "Đã giới hạn kết quả. Hãy tìm cụ thể hơn.", "Results were limited. Refine your search.")}</Typography>}
    {result?.available && !result.matches.length && !result.truncated && <Typography variant="caption">{localize(locale, "Không tìm thấy.", "No matches.")}</Typography>}
  </Stack>;
}
