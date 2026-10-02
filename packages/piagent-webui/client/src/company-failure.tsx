import { localize, type UiLocale } from "./ui-preferences.tsx";

// What each kind of company failure means for the member and what to do next.
// The kind comes from Studio's (or Agent Watch's) own code; the copy never
// names the model behind a harness role.
type Copy = { title: [string, string]; text: [string, string] };
const COPY: Record<string, Copy> = {
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
const OTHER_KEY: [string, string] = ["Cuộc trò chuyện này thuộc thành viên hoặc Studio khác với key đang nhập trong Agent Watch. Nội dung cũ vẫn đọc được; tạo cuộc trò chuyện mới để làm tiếp.",
  "This conversation belongs to another member or Studio than the key Agent Watch holds. It stays readable; start a new conversation to go on."];

export function companyFailureCopy(reason: string, code: string | null, locale: UiLocale): { title: string; text: string } | null {
  const copy = COPY[reason] ?? (reason.startsWith("company-") ? COPY["company-failed"] : undefined);
  if (!copy) return null;
  return { title: localize(locale, ...copy.title), text: localize(locale, ...(code === "managed-session-scope-changed" ? OTHER_KEY : copy.text)) };
}

// Kinds after which "tiếp tục" in the same conversation is the way on (once
// the cause is lifted). The others need something else first: a new
// conversation, an update. A rejected request is continued: a conversation
// too long for the model is summarised before the next one is sent.
const CONTINUABLE = new Set(["company-quota", "company-provider-limit", "company-account", "company-busy", "company-trial-limit", "company-key",
  "company-policy", "company-rejected", "company-unreachable", "company-service", "company-config-changed", "company-failed"]);
export function failureContinuable(reason: string): boolean { return CONTINUABLE.has(reason) || !reason.startsWith("company-"); }

// Who failed: a harness role, never a model name.
export function failureRole(role: "main" | "research" | "review", locale: UiLocale): string {
  return role === "main" ? "Main agent" : role === "research" ? localize(locale, "Subagent nghiên cứu", "Research subagent")
    : localize(locale, "Subagent kiểm tra", "Review subagent");
}
