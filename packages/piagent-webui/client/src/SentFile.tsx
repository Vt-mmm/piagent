import { useEffect, useState } from "react";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { ImageLightbox } from "./AttachmentImage.tsx";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
import { readWorkspaceMedia, saveWorkspaceFile } from "./workspace-api.ts";
import { previewKind } from "./WorkspaceFilePreview.tsx";
import { resolveProjectPath, useWorkspaceSession, WorkspaceFileLink, type FileLink } from "./workspace-navigation.tsx";

// A file the agent sends into the chat, written in its answer as
// ![name](path/in/project): a picture is drawn in place and opens full size,
// any other file is a card to open or save. Outside a conversation, or for a
// path outside the project, only its name is said.
export function SentFile({ link, alt }: { link: FileLink; alt?: string }) {
  const { locale } = useUiPreferences(), session = useWorkspaceSession();
  const name = alt || link.path.split("/").at(-1) || link.path, isImage = previewKind(link.path) === "image";
  const [state, setState] = useState<{ path: string | null; url: string | null; settled: boolean }>({ path: null, url: null, settled: false });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void (async () => {
      const path = await resolveProjectPath(session, link);
      if (!path || !isImage) return { path, url: null };
      const media = await readWorkspaceMedia(session, path, controller.signal);
      return { path, url: media.data && media.mime ? `data:${media.mime};base64,${media.data}` : null };
    })().catch(() => ({ path: null, url: null })).then(value => { if (!controller.signal.aborted) setState({ ...value, settled: true }); });
    return () => controller.abort();
  }, [session, link.path, link.absolute, isImage]);
  if (!session || (state.settled && !state.path)) return <Typography component="span" variant="caption" color="text.secondary">[{name}]</Typography>;
  if (!state.settled) return <Skeleton variant="rounded" width={220} height={isImage ? 140 : 48} sx={{ display: "inline-block" }} aria-label={localize(locale, `Đang tải ${name}`, `Loading ${name}`)} />;
  if (state.url) return <>
    <ButtonBase onClick={() => setOpen(true)} aria-label={localize(locale, `Xem ảnh ${name}`, `View image ${name}`)} title={name}
      sx={{ display: "inline-block", my: .5, borderRadius: 1, overflow: "hidden", border: 1, borderColor: "divider", bgcolor: "background.paper", maxWidth: "100%" }}>
      <Box component="img" src={state.url} alt={name} sx={{ display: "block", maxWidth: "100%", width: { sm: 480 }, maxHeight: 360, objectFit: "contain" }} />
    </ButtonBase>
    <ImageLightbox open={open} onClose={() => setOpen(false)} url={state.url} name={name} locale={locale} />
  </>;
  return <Paper component="span" variant="outlined" sx={{ display: "inline-flex", alignItems: "center", gap: 1, my: .5, px: 1.2, py: .6, borderRadius: 1, maxWidth: "100%" }}>
    <DescriptionOutlined color="action" fontSize="small" />
    <WorkspaceFileLink link={link}>{name}</WorkspaceFileLink>
    <Button size="small" onClick={() => void saveWorkspaceFile(session, state.path!)}>{localize(locale, "Tải về", "Download")}</Button>
  </Paper>;
}
