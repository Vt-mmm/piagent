import { useState, useSyncExternalStore } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { browserSessionLost, subscribeSessionLost } from "./bootstrap.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

const COMMAND = "piagent dashboard";

export function useSessionLost(): boolean {
  return useSyncExternalStore(subscribeSessionLost, browserSessionLost, browserSessionLost);
}

// This tab lost its browser session and cannot sign itself in again: a launch
// link is issued only to a local launcher (the terminal or Agent Watch).
export function SessionExpired({ locale }: { locale: UiLocale }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true), () => setCopied(false)); };
  return <Stack role="alert" spacing={2} sx={{ minHeight: "100vh", alignItems: "center", justifyContent: "center", px: 2, textAlign: "center" }}>
    <Typography variant="h6" component="h1">{localize(locale, "Tab này đã hết phiên đăng nhập", "This tab is no longer signed in")}</Typography>
    <Typography color="text.secondary" sx={{ maxWidth: 520 }}>{localize(locale,
      "Piagent vừa khởi động lại, phiên đã quá 8 giờ, hoặc tab được mở từ một link cũ. Các cuộc trò chuyện vẫn còn nguyên — mở lại Piagent để vào tiếp.",
      "Piagent restarted, the session is older than 8 hours, or this tab came from an old link. Your conversations are kept — open Piagent again to continue.")}</Typography>
    <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
      <Box component="code" sx={{ px: 1.5, py: .75, borderRadius: 1, bgcolor: "action.hover", fontSize: ".9rem" }}>{COMMAND}</Box>
      <Button size="small" variant="outlined" onClick={copy}>{copied ? localize(locale, "Đã chép", "Copied") : localize(locale, "Chép lệnh", "Copy command")}</Button>
    </Box>
    <Typography variant="body2" color="text.secondary">{localize(locale,
      "Chạy lệnh trên trong terminal, hoặc bấm WebUI trong Agent Watch. Sau đó có thể đóng tab này.",
      "Run it in a terminal, or choose WebUI in Agent Watch. You can close this tab afterwards.")}</Typography>
  </Stack>;
}
