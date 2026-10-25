import { Component, Suspense, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// Scope pending/failed module loads to the surface being opened.
export class AsyncSurface extends Component<{ children: ReactNode; locale: UiLocale }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    const { locale, children } = this.props;
    if (this.state.failed) return <Box sx={{ p: 3 }}><Alert severity="error">{localize(locale,
      "Không tải được giao diện. Vui lòng tải lại để thử lại.", "Could not load this view. Reload to try again.")}</Alert>
      <Button onClick={() => window.location.reload()}>{localize(locale, "Tải lại trang", "Reload page")}</Button></Box>;
    return <Suspense fallback={<Box role="status" sx={{ p: 3 }}>{localize(locale, "Đang tải giao diện…", "Loading view…")}</Box>}>{children}</Suspense>;
  }
}
