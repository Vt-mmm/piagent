import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { readDocument, readDocumentIndex } from "./api.ts";
import { readWorkspaceMedia } from "./workspace-api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

// A file the editor cannot show as text, shown as what it is: an image as a
// picture, a PDF or office document as the text the agent reads from it (the
// document index the Documents panel uses). Anything else stays a notice.
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
const DOCUMENTS = new Set(["pdf", "docx", "xlsx", "xlsm", "pptx", "odt", "ods", "odp", "rtf"]);
type Preview = { state: "loading" } | { state: "image"; src: string } | { state: "document"; text: string; truncated: boolean } | { state: "none" };

export function previewKind(path: string): "image" | "document" | null {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGES.has(extension) ? "image" : DOCUMENTS.has(extension) ? "document" : null;
}

export function WorkspaceFilePreview({ sessionRef, path }: { sessionRef: string; path: string }) {
  const { locale } = useUiPreferences(), kind = previewKind(path);
  const [preview, setPreview] = useState<Preview>({ state: kind ? "loading" : "none" });
  useEffect(() => {
    if (!kind) { setPreview({ state: "none" }); return; }
    const controller = new AbortController(), signal = controller.signal;
    setPreview({ state: "loading" });
    const load = async (): Promise<Preview> => {
      if (kind === "image") {
        const media = await readWorkspaceMedia(sessionRef, path, signal);
        return media.data && media.mime ? { state: "image", src: `data:${media.mime};base64,${media.data}` } : { state: "none" };
      }
      const listing = await readDocumentIndex(sessionRef, signal);
      const project = new Set(listing.roots.filter(root => root.source === "project").map(root => root.rootRef));
      const entry = listing.documents.find(item => project.has(item.rootRef) && item.relativePath === path);
      if (!entry) return { state: "none" };
      const document = await readDocument(sessionRef, entry.documentRef, signal);
      return document.state === "ready" && document.text !== null ? { state: "document", text: document.text, truncated: document.truncated } : { state: "none" };
    };
    load().then(value => { if (!signal.aborted) setPreview(value); }, () => { if (!signal.aborted) setPreview({ state: "none" }); });
    return () => controller.abort();
  }, [sessionRef, path, kind]);
  if (preview.state === "loading") return <CircularProgress size={20} sx={{ m: 2 }} />;
  if (preview.state === "image") return <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2, display: "flex", alignItems: "flex-start", justifyContent: "center",
    bgcolor: "action.hover" }}><Box component="img" src={preview.src} alt={path} sx={{ maxWidth: "100%", height: "auto", boxShadow: 1, bgcolor: "background.paper" }} /></Box>;
  if (preview.state === "document") return <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>
    <Typography variant="caption" color="text.secondary">{localize(locale, "Nội dung chữ của tài liệu (chỉ đọc)", "The document's text (read-only)")}
      {preview.truncated ? localize(locale, " · đã rút gọn", " · truncated") : ""}</Typography>
    <Box component="pre" sx={{ m: 0, mt: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: ".92rem", lineHeight: 1.6 }}>{preview.text}</Box>
  </Box>;
  return <Alert severity="info">{localize(locale, "Tệp nhị phân hoặc quá lớn để hiển thị.", "This file is binary or too large to display.")}</Alert>;
}
