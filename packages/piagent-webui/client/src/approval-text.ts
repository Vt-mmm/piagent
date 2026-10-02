import type { ApprovalRequest } from "../../contracts/generated/approval-v1.ts";
import type { UiLocale } from "./locale-preference.ts";
import { label } from "./view-model.ts";

const localize = (locale: UiLocale, vi: string, en: string) => locale === "vi" ? vi : en;

type Action = ApprovalRequest["action"];

// What a member reads on the card. The runtime writes the reason and the
// consequences in English; the known ones are shown in the member's language,
// anything else as written. Internal refs (task, tool call, provider) stay out.
const KINDS: Record<string, [string, string]> = { "workspace-patch": ["Sửa trong project", "Change in the project"],
  "external-provider-action": ["Tác động ra bên ngoài", "Reaches outside this machine"] };
const SCOPES: Record<string, [string, string]> = { "one-shell-command": ["Đúng một lệnh", "This one command"],
  "network-command-once": ["Đúng một lệnh, có mạng", "This one command, with network"], "one-external-action": ["Đúng một hành động", "This one action"] };
const CONSEQUENCES: Record<string, [string, string]> = {
  "Run this exact command once, after the guard checks the working tree again.": ["Chạy đúng lệnh này một lần, sau khi guard kiểm tra lại thư mục làm việc.", ""],
  "The command does not run; the agent is told you declined.": ["Lệnh không chạy; agent được báo là bạn đã từ chối.", ""],
  "Run this exact action once, after the guard checks its authority again.": ["Thực hiện đúng hành động này một lần, sau khi guard kiểm tra lại quyền.", ""],
  "The action does not run; nothing outside changes.": ["Hành động không chạy; không có gì bên ngoài bị thay đổi.", ""],
  "Run this exact command once, with internet access.": ["Chạy đúng lệnh này một lần, có mạng.", ""],
  "Run this exact command once, with internet access; a server it starts accepts connections while it runs.": ["Chạy đúng lệnh này một lần, có mạng; server mà lệnh mở nhận kết nối trong lúc chạy.", ""] };
const known = (table: Record<string, [string, string]>, value: string, locale: UiLocale) => {
  const entry = table[value]; return entry ? localize(locale, entry[0], entry[1] || value) : null;
};
export function approvalReasonText(reason: string, locale: UiLocale): string {
  if (locale !== "vi") return reason;
  return reason.split("; ").map((part) => {
    const command = part.match(/^Confirmation required: the command runs (.+)$/);
    if (command) return `Lệnh có ${command[1]} nên cần bạn duyệt trước khi chạy.`;
    const external = part.match(/^External provider action (.+) requires confirmation$/);
    return external ? `Hành động ra bên ngoài (${external[1]}) cần bạn duyệt.` : part;
  }).join(" ");
}
export const approvalKindText = (action: Pick<Action, "kind">, locale: UiLocale) => known(KINDS, action.kind, locale) ?? label(action.kind, locale);
export const approvalScopeText = (action: Pick<Action, "requestedScope">, locale: UiLocale) => known(SCOPES, action.requestedScope, locale) ?? label(action.requestedScope, locale);
export const approvalConsequenceText = (text: string, locale: UiLocale) => known(CONSEQUENCES, text, locale) ?? text;
