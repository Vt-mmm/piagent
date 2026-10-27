import { useEffect, useState, type ReactNode } from "react";
import CloseRounded from "@mui/icons-material/CloseRounded";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";

import { readJson, sessionInspectionPath } from "./api.ts";
import { loadSentPreview, sentPreviewUrl, stagedPreviewUrl } from "./image-preview-cache.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// The bytes behind an image card in the transcript, fetched when the card shows.
type TranscriptImage = { messageRef: string; index: number; state: "available"; mimeType: string; dataBase64: string };
function readSessionTranscriptImage(sessionRef: string, messageRef: string, index: number): Promise<TranscriptImage> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/transcript-images/${encodeURIComponent(messageRef)}?index=${index}`));
}

// Where an image card's bytes are: still in this browser (just staged), or in
// the session's history, read from the host when the card first shows.
export type ImageSource = { staged: string } | { sessionRef: string; messageRef: string; index: number };

function sentKey(source: Extract<ImageSource, { sessionRef: string }>): string {
  return `${source.sessionRef}\u0000${source.messageRef}\u0000${source.index}`;
}

function usePreviewUrl(source: ImageSource | null): { url: string | null; failed: boolean; fail(): void } {
  const key = !source ? "" : "staged" in source ? `staged:${source.staged}` : sentKey(source);
  const cached = () => !source ? null : "staged" in source ? stagedPreviewUrl(source.staged) : sentPreviewUrl(sentKey(source));
  const [state, setState] = useState(() => ({ key, url: cached(), failed: false }));
  // Another image in the same slot (a page of history reloaded): start over.
  if (state.key !== key) setState({ key, url: cached(), failed: false });
  useEffect(() => {
    if (!source || "staged" in source || sentPreviewUrl(key)) return;
    let live = true;
    void loadSentPreview(key, () => readSessionTranscriptImage(source.sessionRef, source.messageRef, source.index))
      .then((url) => { if (live) setState({ key, url, failed: !url }); });
    return () => { live = false; };
  }, [key]);
  // A staged image whose preview was never kept has nothing to wait for.
  const failed = state.failed || !source || ("staged" in source && !state.url);
  return { url: state.key === key ? state.url : null, failed, fail: () => setState({ key, url: null, failed: true }) };
}

// The picture itself, in place of a card that only said "Image". Clicking it
// opens it full size. Without a preview (an old host, an evicted cache, a type
// the browser cannot draw) the card it replaces is shown instead.
export function AttachmentImage({ name, source, locale, fallback }: { name: string; source: ImageSource | null; locale: UiLocale;
  fallback: ReactNode }) {
  const { url, failed, fail } = usePreviewUrl(source), [open, setOpen] = useState(false);
  if (failed) return <>{fallback}</>;
  if (!url) return <Skeleton variant="rounded" width={220} height={140} aria-label={localize(locale, "Đang tải ảnh", "Loading image")} />;
  return <>
    <ButtonBase onClick={() => setOpen(true)} aria-label={localize(locale, `Xem ảnh ${name}`, `View image ${name}`)} title={name}
      sx={{ alignSelf: "flex-start", borderRadius: 1, overflow: "hidden", border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
      <Box component="img" src={url} alt={name} onError={fail} loading="lazy"
        sx={{ display: "block", maxWidth: { xs: "100%", sm: 320 }, maxHeight: 220, objectFit: "contain" }} />
    </ButtonBase>
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth={false}
      slotProps={{ paper: { sx: { bgcolor: "background.default", m: 1, maxWidth: "96vw", maxHeight: "94vh" } } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, pl: 2, pr: .5, py: .5 }}>
        <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: 600 }}>{name}</Typography>
        <IconButton size="small" aria-label={localize(locale, "Đóng", "Close")} onClick={() => setOpen(false)}><CloseRounded fontSize="small" /></IconButton>
      </Box>
      <Box component="img" src={url} alt={name}
        sx={{ display: "block", maxWidth: "96vw", maxHeight: "calc(94vh - 48px)", objectFit: "contain", mx: "auto" }} />
    </Dialog>
  </>;
}
