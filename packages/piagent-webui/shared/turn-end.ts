// How a member's message ended in a company conversation ("agent-watch-turn-end"),
// read the same way by the transcript, the session list and the company
// Terminal: every checklist step done, stopped with steps open, failed (which
// harness role), or stopped by the member.
import { failureRoleText, type CopyLocale, type FailureRole } from "./company-copy.ts";

export type TurnEndState = "done" | "midway" | "failed" | "cancelled";
export type TurnEnd = { state: TurnEndState; planSteps: number; planDone: number; rounds: number;
  reason?: "idle" | "limit" | "policy"; role?: FailureRole; code?: string };
const ROLES: FailureRole[] = ["main", "scout", "research", "verify", "review"];
// The harness gives up after this many rounds in a row without progress, and
// runs at most this many (packages/piagent-core/managed/continuation.mjs).
export const IDLE_ROUNDS = 2, MAX_ROUNDS = 30;

// The recorded details, checked; null when they do not have the expected shape.
export function turnEndOf(details: any): TurnEnd | null {
  const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 30;
  if (!["done", "midway", "failed", "cancelled"].includes(details?.state) || !count(details.planSteps) || !count(details.planDone)
    || details.planDone > details.planSteps || !count(details.rounds)) return null;
  const out: TurnEnd = { state: details.state, planSteps: details.planSteps, planDone: details.planDone, rounds: details.rounds };
  if (details.state === "midway" && ["idle", "limit", "policy"].includes(details.reason)) out.reason = details.reason;
  if (details.state === "failed") {
    out.role = ROLES.includes(details.role) ? details.role : "main";
    if (typeof details.code === "string" && /^[a-z0-9_]{1,64}$/.test(details.code)) out.code = details.code;
  }
  return out;
}

const pick = (locale: CopyLocale, vi: string, en: string) => locale === "vi" ? vi : en;
export type TurnEndCopy = { tone: "success" | "warning" | "error" | "info"; title: string; text: string; continuable: boolean };

// What the member reads under the last answer: is the task finished, and if
// not, why the agent stopped and what to do.
export function turnEndCopy(end: TurnEnd, locale: CopyLocale): TurnEndCopy {
  const open = end.planSteps - end.planDone;
  const rounds = end.rounds ? pick(locale, ` Harness đã cho agent làm tiếp ${end.rounds} vòng.`, ` The harness sent the agent back ${end.rounds} time(s).`) : "";
  if (end.state === "cancelled") return { tone: "info", continuable: true, title: pick(locale, "Bạn đã dừng lượt này", "You stopped this turn"),
    text: pick(locale, `Task chưa xong${end.planSteps ? ` (${end.planDone}/${end.planSteps} bước)` : ""}. Bấm Tiếp tục để agent làm tiếp từ chỗ dừng.`,
      `The task is not finished${end.planSteps ? ` (${end.planDone}/${end.planSteps} steps)` : ""}. Choose Continue to pick up where it stopped.`) };
  if (end.state === "failed") return { tone: "error", continuable: true,
    title: pick(locale, `Lượt dừng vì lỗi · ${failureRoleText(end.role ?? "main", locale)}`, `Turn stopped by a failure · ${failureRoleText(end.role ?? "main", locale)}`),
    text: pick(locale, `Task chưa xong${end.planSteps ? `: còn ${open}/${end.planSteps} bước` : ""}. Xem lỗi phía trên; khi đã xử lý, bấm Tiếp tục để chạy lại từ chỗ dừng.`,
      `The task is not finished${end.planSteps ? `: ${open} of ${end.planSteps} steps open` : ""}. See the failure above; once it is resolved, choose Continue.`) + (end.code ? ` [${end.code}]` : "") };
  if (end.state === "midway") {
    const why = end.reason === "idle" ? pick(locale, `Main agent dừng ${IDLE_ROUNDS} vòng liên tiếp mà không xong thêm bước nào: đọc câu trả lời cuối để biết vướng gì.`,
      `The main agent stopped ${IDLE_ROUNDS} rounds in a row without finishing a step: its last answer says what is in the way.`)
      : end.reason === "limit" ? pick(locale, `Đã tới giới hạn ${MAX_ROUNDS} vòng tự làm tiếp cho một tin nhắn.`, `The limit of ${MAX_ROUNDS} automatic rounds for one message was reached.`)
      : pick(locale, "Harness của team không bắt buộc plan nên không tự làm tiếp.", "The team's Harness does not require a plan, so it does not continue on its own.");
    return { tone: "warning", continuable: true, title: pick(locale, `Dừng giữa chừng · còn ${open}/${end.planSteps} bước`, `Stopped midway · ${open} of ${end.planSteps} steps open`),
      text: `${why}${rounds} ${pick(locale, "Bấm Tiếp tục để làm tiếp.", "Choose Continue to go on.")}` };
  }
  return { tone: "success", continuable: false, title: end.planSteps ? pick(locale, `Hoàn thành · ${end.planSteps}/${end.planSteps} bước`, `Done · ${end.planSteps}/${end.planSteps} steps`) : pick(locale, "Xong lượt", "Turn finished"),
    text: (end.planSteps ? pick(locale, "Mọi bước trong checklist đã xong.", "Every checklist step is completed.") : pick(locale, "Main agent đã trả lời xong; lượt này không có checklist.", "The main agent finished its answer; this turn had no checklist.")) + rounds };
}

// The short label of the session list.
export function turnEndShort(end: Pick<TurnEnd, "state" | "planSteps" | "planDone">, locale: CopyLocale): string {
  if (end.state === "midway") return pick(locale, `Dừng giữa chừng ${end.planDone}/${end.planSteps}`, `Stopped ${end.planDone}/${end.planSteps}`);
  if (end.state === "failed") return pick(locale, "Lỗi, chưa xong", "Failed");
  if (end.state === "cancelled") return pick(locale, "Đã dừng", "Stopped");
  return end.planSteps ? pick(locale, `Xong ${end.planSteps}/${end.planSteps}`, `Done ${end.planSteps}/${end.planSteps}`) : pick(locale, "Xong", "Done");
}
