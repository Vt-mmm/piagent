// What a company failure means for the member and what to do next, in
// Vietnamese and English: the dashboard and the company Terminal say the same.
// The kind comes from Studio's (or Agent Watch's) own code; the copy never
// names the model behind a harness role.
export type CopyLocale = "vi" | "en";
const pick = (locale: CopyLocale, [vi, en]: [string, string]) => locale === "vi" ? vi : en;

// Why the company runtime did not start (Agent Watch launch codes).
export const LAUNCH_REASONS: Record<string, [string, string]> = {
  "managed-config-missing": ["Chưa nhập cấu hình công ty. Mở Agent Watch → Studio → Nhập cấu hình cho Piagent (trên Windows: Kết nối Piagent trong WSL).", "Company configuration is not imported. Open Agent Watch → Studio and import it for Piagent (on Windows: Connect Piagent in WSL)."],
  "managed-keychain-approval-required": ["macOS chưa cho Agent Watch đọc key. Chọn “Luôn cho phép” khi được hỏi rồi kết nối lại.", "macOS did not let Agent Watch read the key. Choose “Always Allow” when asked, then connect again."],
  "managed-key-unavailable": ["Agent Watch không đọc được key công ty trên máy này. Mở Agent Watch, dán lại mã kết nối, bấm Kết nối Piagent trong WSL rồi kết nối lại.", "Agent Watch cannot read the company key on this computer. Open Agent Watch, paste the connection code again, choose Connect Piagent in WSL, then connect again."],
  "managed-profile-disconnected": ["Cấu hình Piagent đang thuộc key công ty đã ngắt kết nối. Nhập lại cấu hình cho Piagent trong Agent Watch (trên Windows: Kết nối Piagent trong WSL).", "The Piagent configuration belongs to a disconnected company key. Import it again in Agent Watch (on Windows: Connect Piagent in WSL)."],
  "managed-launch-binding-changed": ["Agent Watch hoặc Piagent vừa cập nhật. Nhập lại cấu hình cho Piagent trong Agent Watch (trên Windows: Kết nối Piagent trong WSL).", "Agent Watch or Piagent changed. Import the Piagent configuration again in Agent Watch (on Windows: Connect Piagent in WSL)."],
  "managed-launch-version-mismatch": ["Agent Watch đang dùng một bản Piagent khác với dashboard này. Mở Agent Watch → Studio, bấm Áp dụng cho Piagent rồi kết nối lại.", "Agent Watch points at another Piagent install than this dashboard. Open Agent Watch → Studio, apply for Piagent, then connect again."],
  "managed-launch-stale-runtime": ["Phiên công ty của bản Piagent cũ chưa dừng được. Thử kết nối lại sau ít giây.", "The company runtime from the previous Piagent did not stop yet. Connect again in a few seconds."],
  "managed-launch-timeout": ["Phiên công ty khởi động quá lâu. Kết nối lại.", "The company runtime took too long to start. Connect again."]
};

export type Copy = { title: [string, string]; text: [string, string] };
export const COPY: Record<string, Copy> = {
  "company-quota": { title: ["Hết hạn mức token", "Token quota used up"],
    text: ["Hạn mức token của key này đã hết. Chờ kỳ hạn mức mới hoặc liên hệ quản trị viên để tăng hạn mức.",
      "This key's token quota is used up. Wait for the next quota period or ask an administrator to raise it."] },
  "company-provider-limit": { title: ["Tài khoản model của công ty hết lượt", "Company model account limited"],
    text: ["Nhà cung cấp đang giới hạn tài khoản model của công ty (hết lượt dùng hoặc quá tải). Thử lại sau; quản trị viên có thể đổi model trong Harness.",
      "The provider is limiting the company's model account (out of usage or overloaded). Try again later; an administrator can switch the harness model."] },
  "company-account": { title: ["Tài khoản model cần đăng nhập lại", "Model account must sign in again"],
    text: ["Tài khoản model của công ty đã hết phiên đăng nhập. Quản trị viên cần đăng nhập lại trong Studio (Tài khoản AI).",
      "The company's model account is signed out. An administrator has to sign it in again in Studio (AI accounts)."] },
  "company-busy": { title: ["Đang quá tải", "Busy"],
    text: ["Studio đang xử lý quá nhiều request của key này, hoặc tài khoản model đang bận. Chờ vài giây rồi gửi lại.",
      "Studio is handling too many requests for this key, or the model account is busy. Wait a few seconds and send again."] },
  "company-trial-limit": { title: ["Studio hết lượt thử nghiệm", "Studio live-test limit reached"],
    text: ["Studio đã dùng hết số request thử nghiệm được cấp. Quản trị viên cần nâng trần trước khi chạy tiếp.",
      "Studio has used up its live-test request ceiling. An administrator has to raise it before anything runs."] },
  "company-key": { title: ["Key công ty không dùng được", "Company key unusable"],
    text: ["Key công ty đã hết hạn, bị thu hồi, hoặc Agent Watch không đọc được. Nhập lại key trong Agent Watch.",
      "The company key expired, was revoked, or Agent Watch cannot read it. Import the key again in Agent Watch."] },
  "company-policy": { title: ["Không được phép", "Not allowed"],
    text: ["Key này không được dùng model, mức suy luận hoặc độ dài trả lời đang chọn. Nếu Harness vừa đổi, gửi lại để dùng cấu hình mới; nếu vẫn lỗi, kiểm tra Harness trong Studio.",
      "This key may not use this model, thinking level or answer length. If the harness just changed, send again to use the new one; otherwise check the harness in Studio."] },
  "company-new-session": { title: ["Cần cuộc trò chuyện mới", "New conversation needed"],
    text: ["Cuộc trò chuyện này không tiếp tục được với tài khoản model hiện tại. Nội dung cũ vẫn đọc được; tạo cuộc trò chuyện mới để làm tiếp.",
      "This conversation cannot continue with the current model account. It stays readable; start a new conversation to go on."] },
  "company-rejected": { title: ["Yêu cầu bị từ chối", "Request rejected"],
    text: ["Model từ chối yêu cầu này, thường vì cuộc trò chuyện đã dài hơn model hiện tại nhận được. Bấm Tiếp tục: phần cũ được tóm tắt rồi mới gửi. Nếu vẫn bị từ chối, rút gọn tin nhắn hoặc tạo cuộc trò chuyện mới.",
      "The model rejected this request, usually because the conversation grew longer than the current model accepts. Press Continue: the older part is summarised before sending. If it is still rejected, shorten the message or start a new conversation."] },
  "company-refused": { title: ["Model từ chối yêu cầu này", "The model declined this request"],
    text: ["Nhà cung cấp model từ chối yêu cầu này theo chính sách sử dụng của họ (ví dụ: in, mã hoá hoặc gửi ra ngoài thông tin bí mật). Gửi lại nguyên văn sẽ bị từ chối tiếp; hãy viết lại yêu cầu theo cách khác.",
      "The model's provider declined this request under its usage policy (for example, printing, encoding or sending out secrets). The same request is declined again; ask in a different way."] },
  "company-unreachable": { title: ["Lỗi kết nối", "Connection error"],
    text: ["Không kết nối được tới Studio. Kiểm tra mạng hoặc VPN rồi gửi lại.", "Studio could not be reached. Check the network or VPN and send again."] },
  "company-service": { title: ["Dịch vụ model lỗi", "Model service error"],
    text: ["Studio đã nhận yêu cầu nhưng dịch vụ model phía sau không trả lời. Gửi lại; nếu lặp lại, báo quản trị viên kèm mã bên dưới.",
      "Studio took the request but its model service did not answer. Send again; if it repeats, give an administrator the code below."] },
  "company-config-changed": { title: ["Cấu hình vừa thay đổi", "Configuration changed"],
    text: ["Key hoặc Harness vừa thay đổi trong Studio. Gửi lại để chạy với cấu hình mới.", "The key or harness just changed in Studio. Send again to run with the new one."] },
  "company-update": { title: ["Cần cập nhật Piagent", "Piagent update needed"],
    text: ["Harness dùng model mà bản Piagent này chưa biết. Cập nhật Piagent rồi gửi lại.", "The harness uses a model this Piagent does not know. Update Piagent and send again."] },
  "company-tool": { title: ["Công cụ lỗi", "Tool error"],
    text: ["Công cụ này không chạy được ở bước này (ví dụ subagent đã chạy đủ 8 lần cho tin nhắn này).", "This tool could not run at this step (for example, the subagent already ran 8 times for this message)."] },
  "company-failed": { title: ["Lỗi chưa phân loại", "Unclassified error"],
    text: ["Yêu cầu không hoàn tất. Gửi lại; nếu lặp lại, báo quản trị viên kèm mã bên dưới.",
      "The request did not complete. Send again; if it repeats, give an administrator the code below."] },
};
export const OTHER_KEY: [string, string] = ["Cuộc trò chuyện này thuộc thành viên hoặc Studio khác với key đang nhập trong Agent Watch. Nội dung cũ vẫn đọc được; tạo cuộc trò chuyện mới để làm tiếp.",
  "This conversation belongs to another member or Studio than the key Agent Watch holds. It stays readable; start a new conversation to go on."];

// Codes that say more than their kind: no account serves a role's model, or
// the run started without one (the subagent then cannot run at all).
export const CODE_COPY: Record<string, Copy> = {
  "harness_route_unavailable": { title: ["Không có tài khoản AI cho vai trò này", "No AI account for this role"],
    text: ["Không tài khoản AI nào của công ty đang phục vụ model của vai trò này cho team (tài khoản bị ngắt, tắt cho team hoặc hết lượt). Quản trị viên cần gắn hoặc bật tài khoản trong Studio (Tài khoản AI), hoặc đổi model của vai trò trong Harness.",
      "No company AI account serves this role's model for the team right now (disconnected, off for the team or out of usage). An administrator has to link or enable one in Studio (AI accounts), or change the role's model in the harness."] },
  "harness_profile_unavailable": { title: ["Harness không có model cho vai trò này", "Harness has no model for this role"],
    text: ["Lượt này bắt đầu khi Harness của team không có model dùng được cho vai trò này. Quản trị viên kiểm tra Harness và tài khoản AI của team trong Studio, rồi gửi lại.",
      "This run started while the team's harness had no usable model for this role. An administrator checks the team's harness and AI accounts in Studio; then send again."] },
};

export function launchReasonText(code: string, locale: CopyLocale): string | null {
  const reason = LAUNCH_REASONS[code];
  return reason ? pick(locale, reason) : null;
}

export function companyFailureText(reason: string, code: string | null, locale: CopyLocale): { title: string; text: string } | null {
  const copy = (code ? CODE_COPY[code] : undefined) ?? COPY[reason] ?? (reason.startsWith("company-") ? COPY["company-failed"] : undefined);
  if (!copy) return null;
  return { title: pick(locale, copy.title), text: pick(locale, code === "managed-session-scope-changed" ? OTHER_KEY : copy.text) };
}

// Who failed: a harness role, never a model name.
export type FailureRole = "main" | "scout" | "research" | "verify" | "review";
export function failureRoleText(role: FailureRole, locale: CopyLocale): string {
  return role === "main" ? "Main agent" : role === "scout" ? pick(locale, ["Subagent scout", "Scout subagent"])
    : role === "research" ? pick(locale, ["Subagent research", "Research subagent"])
    : role === "verify" ? pick(locale, ["Subagent verify", "Verify subagent"])
    : pick(locale, ["Subagent review", "Review subagent"]);
}
