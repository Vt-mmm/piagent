import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";

import { connectCompany, readCompanyStatus, type CompanyStatus } from "./api.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

const REASONS: Record<string, [string, string]> = {
  "managed-config-missing": ["Chưa nhập cấu hình công ty. Mở Agent Watch → Studio → Nhập cấu hình cho Piagent.", "Company configuration is not imported. Open Agent Watch → Studio and import it for Piagent."],
  "managed-keychain-approval-required": ["macOS chưa cho Agent Watch đọc key. Chọn “Luôn cho phép” khi được hỏi rồi kết nối lại.", "macOS did not let Agent Watch read the key. Choose “Always Allow” when asked, then connect again."],
  "managed-profile-disconnected": ["Cấu hình Piagent đang thuộc key công ty đã ngắt kết nối. Nhập lại cấu hình cho Piagent trong Agent Watch.", "The Piagent configuration belongs to a disconnected company key. Import it again in Agent Watch."],
  "managed-launch-binding-changed": ["Agent Watch hoặc Piagent vừa cập nhật. Nhập lại cấu hình cho Piagent trong Agent Watch.", "Agent Watch or Piagent changed. Import the Piagent configuration again in Agent Watch."],
  "managed-launch-version-mismatch": ["Agent Watch đang dùng một bản Piagent khác với dashboard này. Mở Agent Watch → Studio, bấm Áp dụng cho Piagent rồi kết nối lại.", "Agent Watch points at another Piagent install than this dashboard. Open Agent Watch → Studio, apply for Piagent, then connect again."],
  "managed-launch-stale-runtime": ["Phiên công ty của bản Piagent cũ chưa dừng được. Thử kết nối lại sau ít giây.", "The company runtime from the previous Piagent did not stop yet. Connect again in a few seconds."],
  "managed-launch-timeout": ["Phiên công ty khởi động quá lâu. Kết nối lại.", "The company runtime took too long to start. Connect again."]
};

// Why a new conversation could not be created, in words; the code stays at
// the end for support. Company reasons say what to do in Agent Watch.
const CREATE_FAILURES: Record<string, [string, string]> = {
  "session-revision-stale": ["Danh sách cuộc trò chuyện vừa thay đổi. Gửi lại tin nhắn.", "The conversation list just changed. Send the message again."],
  "catalog-unavailable": ["Danh sách cuộc trò chuyện chưa tải xong. Thử lại sau vài giây.", "The conversation list has not loaded yet. Try again in a few seconds."],
  "session-model-mismatch": ["Cuộc trò chuyện đã tạo nhưng đang dùng model khác model đã chọn, nên tin nhắn chưa được gửi.", "The conversation was created with a different model than the one chosen, so the message was not sent."],
  "gateway-command-response-timeout": ["Piagent chưa xác nhận được cuộc trò chuyện mới sau 2 phút; nó có thể đã được tạo và đang chạy. Xem danh sách cuộc trò chuyện bên trái trước khi gửi lại.",
    "Piagent could not confirm the new conversation within 2 minutes; it may have been created and be running. Check the conversation list before sending again."],
  "session-command-expired": ["Yêu cầu chờ quá lâu nên đã hết hạn. Gửi lại tin nhắn.", "The request waited too long and expired. Send the message again."],
};
export function createFailureText(code: string, locale: UiLocale): string {
  const known = CREATE_FAILURES[code] ?? REASONS[code];
  return known ? localize(locale, ...known) : `${localize(locale, "Chưa tạo được cuộc trò chuyện", "The conversation could not be created")} (${code}).`;
}

// Why the company runtime is not connected, for the member; null when the
// reason is only that it is not running.
export function companyReasonDetail(status: CompanyStatus | null | undefined, locale: UiLocale): string | null {
  const reason = REASONS[status?.reasonCode ?? ""];
  return reason ? localize(locale, ...reason) : null;
}

export const companyReason = (status: CompanyStatus | null | undefined, locale: UiLocale) => status?.state === "connecting"
  ? localize(locale, "Đang kết nối phiên công ty…", "Connecting the company runtime…")
  : companyReasonDetail(status, locale) ?? localize(locale, "Chưa kết nối phiên công ty. Bấm để kết nối.", "The company runtime is not connected. Select to connect.");

// A company conversation opened while the company runtime is not running
// (stopped, crashed, Agent Watch or Piagent updated). Reading never starts it,
// since starting may ask macOS for Keychain access, so the member starts it
// here. It also shows up by itself when the runtime comes back.
export function CompanyReconnect({ locale, onConnected }: { locale: UiLocale; onConnected(): void }) {
  const [status, setStatus] = useState<CompanyStatus | null>(), [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let alive = true, ready = false;
    const read = () => void readCompanyStatus().then((value) => {
      if (!alive) return;
      setStatus(value);
      if (value?.state === "ready" && !ready) { ready = true; onConnected(); }
    }).catch(() => undefined);
    read(); const timer = window.setInterval(read, 5_000);
    return () => { alive = false; window.clearInterval(timer); };
    // onConnected only reloads this conversation; a new function each render must not restart polling.
  }, []);
  if (!status || status.state === "ready" || status.state === "unconfigured") return null;
  const connect = async () => {
    setConnecting(true);
    try { const next = await connectCompany(); setStatus(next); if (next.state === "ready") onConnected(); }
    catch { setStatus(await readCompanyStatus().catch(() => null) ?? status); }
    finally { setConnecting(false); }
  };
  const detail = companyReasonDetail(status, locale), busy = connecting || status.state === "connecting";
  return <Alert severity="warning" role="status" sx={{ mb: 2 }} action={<Button color="inherit" size="small" disabled={busy} onClick={() => void connect()} sx={{ whiteSpace: "nowrap" }}>
      {busy ? localize(locale, "Đang kết nối…", "Connecting…") : localize(locale, "Kết nối lại", "Reconnect")}</Button>}>
    {localize(locale, "Chế độ công ty đang tắt nên chưa đọc hay gửi tiếp được cuộc trò chuyện này. Bấm Kết nối lại; macOS có thể hỏi quyền đọc key một lần.",
      "Company mode is not running, so this conversation cannot be read or continued yet. Select Reconnect; macOS may ask once to read the key.")}
    {detail && <> {detail}</>}
  </Alert>;
}
