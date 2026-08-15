import { useEffect, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Receipt } from "../../contracts/generated/control-command-v1.ts";
import { sendLifecycleCommand } from "./api.ts";
import { createLifecycleCommand } from "./chat-command.ts";
import { label } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

type Action = "lifecycle.stop" | "lifecycle.pause" | "lifecycle.resume";
type Props = { snapshot: PiagentWebUICanonicalSnapshotV1; refreshSnapshot?: () => Promise<PiagentWebUICanonicalSnapshotV1 | undefined> };

const resultText: Record<string, string> = {
  stopped: "Đã dừng lượt Pi hiện tại; task vẫn được giữ lại.", "emergency-stop": "Đã dừng lượt Pi hiện tại.",
  "stop-requested": "Đang chờ Pi xác nhận lượt hiện tại đã dừng.", "already-idle": "Pi đang chờ, không có lượt nào cần dừng.",
  "pause-requested": "Đang chờ tool hiện tại kết thúc tại điểm an toàn.", paused: "Task đã tạm dừng an toàn.",
  "already-pausing": "Task đang chờ điểm tạm dừng an toàn.", "already-paused": "Task đang được tạm dừng.",
  resumed: "Task đã hoạt động lại; chưa gửi thêm tin nhắn cho model.", "pause-cancelled": "Đã hủy yêu cầu tạm dừng; chưa gọi model.",
  "already-active": "Task đang hoạt động.", "resume-rejected": "Chưa thể tiếp tục vì bằng chứng khôi phục chưa đủ an toàn.",
  "settlement-unknown": "Chưa xác nhận được Pi đã dừng. Hãy xem trạng thái mới trước khi thử lại.",
  "pause-unconfirmed": "Chưa đủ bằng chứng để xác nhận task đã tạm dừng."
};

const resultTextEn: Record<string, string> = {
  stopped: "Stopped the current Pi turn; the task remains intact.", "emergency-stop": "Stopped the current Pi turn.",
  "stop-requested": "Waiting for Pi to confirm the current turn has stopped.", "already-idle": "Pi is idle; there is no turn to stop.",
  "pause-requested": "Waiting for the current tool to finish at a safe point.", paused: "The task is safely paused.",
  "already-pausing": "The task is waiting for a safe pause point.", "already-paused": "The task is paused.",
  resumed: "The task is active again; no model message was sent.", "pause-cancelled": "Cancelled the pause request; no model call was made.",
  "already-active": "The task is active.", "resume-rejected": "Resume is blocked because recovery evidence is not yet safe.",
  "settlement-unknown": "Pi stop is unconfirmed. Refresh status before trying again.",
  "pause-unconfirmed": "There is not enough evidence to confirm the task is paused."
};

function receiptText(receipt: Receipt, locale: UiLocale): string {
  return (locale === "vi" ? resultText : resultTextEn)[receipt.resultCode]
    ?? (receipt.error?.message || `${localize(locale, "Chưa thực hiện", "Not executed")} · ${label(receipt.resultCode, locale)}`);
}

export function LifecyclePanel({ snapshot, refreshSnapshot }: Props) {
  const { locale } = useUiPreferences();
  const capability = snapshot.capabilities.capabilities["control.lifecycle"];
  const [pending, setPending] = useState<Action | null>(null);
  const [last, setLast] = useState<{ action: Action; resultCode: string; text: string } | null>(null);
  const available = capability.status === "available", phase = available ? capability.currentPhase : "unknown";
  const stop = available ? capability.stopPhaseSupport[phase] : null;
  const canStop = Boolean(stop?.stop === "supported" && snapshot.identity.agentOperationId);
  const canPause = Boolean(available && capability.actions.pause.available);
  const canResume = Boolean(available && capability.actions.resume.available);

  useEffect(() => {
    if (last?.resultCode === "pause-requested" && snapshot.session.controlState === "paused")
      setLast({ action: "lifecycle.pause", resultCode: "paused", text: (locale === "vi" ? resultText : resultTextEn).paused });
    if (last?.resultCode === "stop-requested" && snapshot.session.operation.liveness === "idle")
      setLast({ action: "lifecycle.stop", resultCode: "stopped", text: (locale === "vi" ? resultText : resultTextEn).stopped });
  }, [last?.resultCode, locale, snapshot.session.controlState, snapshot.session.operation.liveness]);

  const run = async (action: Action) => {
    if (pending) return;
    setPending(action); setLast(null);
    try {
      const receipt = await sendLifecycleCommand(await createLifecycleCommand(snapshot, action));
      setLast({ action, resultCode: receipt.resultCode, text: receiptText(receipt, locale) });
      await refreshSnapshot?.();
    } catch { setLast({ action, resultCode: "request-failed", text: localize(locale, "Trạng thái Pi đã thay đổi hoặc kết nối local bị gián đoạn. Hãy tải trạng thái mới rồi thử lại.", "Pi state changed or the local connection was interrupted. Refresh status before trying again.") }); }
    finally { setPending(null); }
  };

  return <section className="lifecycle-panel surface" aria-labelledby="lifecycle-title">
    <div className="lifecycle-copy"><p className="section-kicker">{localize(locale, "Điều khiển task", "Task controls")}</p><h2 id="lifecycle-title">Stop, pause &amp; resume</h2>
      <p>{localize(locale, "Stop dừng lượt Pi đang chạy. Pause chờ tool hiện tại kết thúc rồi giữ task. Resume chỉ mở lại task, không tự gọi model. Muốn mở lại và giao việc ngay, dùng “Tiếp tục & gửi” trong Chat.", "Stop ends the running Pi turn. Pause waits for the current tool to reach a safe point and holds the task. Resume reopens the task without calling the model. Use “Resume & send” in Chat to continue with new work.")}</p></div>
    <div className="lifecycle-state"><span>{localize(locale, "Trạng thái", "Status")}</span><strong>{label(snapshot.session.controlState, locale)}</strong>
      <small>Pi: {label(snapshot.session.operation.liveness, locale)} · phase: {label(phase, locale)}</small></div>
    <div className="lifecycle-actions">
      <button type="button" className="danger-action" disabled={pending !== null || !canStop} onClick={() => void run("lifecycle.stop")}
        title={!canStop ? label(stop?.reasonCode ?? "no-current-operation", locale) : undefined}>{pending === "lifecycle.stop" ? localize(locale, "Đang dừng…", "Stopping…") : localize(locale, "Dừng lượt hiện tại", "Stop current turn")}</button>
      <button type="button" className="secondary-action" disabled={pending !== null || !canPause} onClick={() => void run("lifecycle.pause")}
        title={!canPause && available ? label(capability.actions.pause.reasonCode, locale) : undefined}>{pending === "lifecycle.pause" ? localize(locale, "Đang yêu cầu…", "Requesting…") : localize(locale, "Tạm dừng task", "Pause task")}</button>
      <button type="button" className="primary-action" disabled={pending !== null || !canResume} onClick={() => void run("lifecycle.resume")}
        title={!canResume && available ? label(capability.actions.resume.reasonCode, locale) : undefined}>{pending === "lifecycle.resume" ? localize(locale, "Đang mở lại…", "Resuming…") : localize(locale, "Tiếp tục task", "Resume task")}</button>
    </div>
    {last && <p className={`lifecycle-result result-${last.resultCode === "request-failed" || last.resultCode.includes("unknown") || last.resultCode.includes("unconfirmed") || last.resultCode === "resume-rejected" ? "warning" : "ok"}`} role="status">{last.text}</p>}
    {!available && <p className="lifecycle-result result-warning">{localize(locale, "Điều khiển chưa sẵn sàng", "Controls unavailable")} · {label(capability.reason?.code, locale)}</p>}
  </section>;
}
