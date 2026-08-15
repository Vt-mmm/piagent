import { useState } from "react";

import type { Activity, PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { readLogPreview, readSessionLogPreview, type LogPreview } from "./api.ts";
import { activityResult, activityTime } from "./activity-view-model.ts";
import { tone } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

type PreviewState = { state: "loading" | "ready" | "error"; value?: LogPreview };

function ActivityRow({ activity, preview, onPreview, locale }: { activity: Activity; preview?: PreviewState; onPreview(): void; locale: UiLocale }) {
  return <article className="activity-row">
    <span className={`activity-state tone-${tone(activity.state)}`} aria-label={activity.state} />
    <div className="activity-copy"><div><strong>{activity.label}</strong><span>{activity.kind}</span></div><p>{activity.preview || localize(locale, "Không có mô tả ngắn", "No short description")}</p>
      {preview && <div className={`log-preview ${preview.state === "error" ? "error-state" : ""}`}>
        {preview.state === "loading" ? localize(locale, "Đang tải log ngắn…", "Loading log preview…") : preview.state === "error" ? localize(locale, "Log preview không còn sẵn sàng.", "Log preview is no longer available.") : preview.value?.preview ?? `${localize(locale, "Không có nội dung log", "No log content")} · ${preview.value?.reasonCode ?? "unavailable"}`}
        {preview.value?.truncated && <small>{localize(locale, "Preview đã được rút gọn", "Preview truncated")}</small>}
      </div>}
    </div>
    <div className="activity-result"><strong>{activityResult(activity, locale)}</strong><span>{activityTime(activity, locale)}</span>
      <button type="button" onClick={onPreview} aria-expanded={Boolean(preview)}>{preview ? localize(locale, "Ẩn log", "Hide log") : localize(locale, "Xem log", "View log")}</button>
    </div>
  </article>;
}

export function ActivityPanel({ snapshot, sessionRef }: { snapshot: PiagentWebUICanonicalSnapshotV1; sessionRef?: string }) {
  const { locale } = useUiPreferences();
  const [previews, setPreviews] = useState<Record<string, PreviewState | undefined>>({});
  const activities = [...snapshot.activity.running, ...snapshot.activity.recent];
  const toggle = (activity: Activity) => {
    if (previews[activity.activityRef]) { setPreviews((current) => ({ ...current, [activity.activityRef]: undefined })); return; }
    setPreviews((current) => ({ ...current, [activity.activityRef]: { state: "loading" } }));
    const request = sessionRef ? readSessionLogPreview(sessionRef, activity.activityRef) : readLogPreview(activity.activityRef);
    void request.then((value) => setPreviews((current) => ({ ...current, [activity.activityRef]: { state: "ready", value } })))
      .catch(() => setPreviews((current) => ({ ...current, [activity.activityRef]: { state: "error" } })));
  };
  return <section className="activity-panel surface" aria-labelledby="activity-title">
    <header className="panel-heading"><div><p className="section-kicker">Activity</p><h2 id="activity-title">{localize(locale, "Tool, command và verifier", "Tools, commands, and verifiers")}</h2></div><div><span className="running-count">{snapshot.activity.running.length} {localize(locale, "đang chạy", "running")}</span><span>{snapshot.activity.page.total} {localize(locale, "gần đây", "recent")}</span></div></header>
    <div className="activity-list">
      {activities.map((activity) => <ActivityRow key={activity.activityRef} activity={activity} preview={previews[activity.activityRef]} onPreview={() => toggle(activity)} locale={locale} />)}
      {activities.length === 0 && <div className="activity-empty">{localize(locale, "Chưa có tool call hoặc command nào trong timeline hiện tại.", "No tool calls or commands in the current timeline.")}</div>}
    </div>
    {snapshot.activity.page.truncated && <footer className="panel-footnote">{localize(locale, "Timeline đã được rút gọn theo giới hạn local.", "The timeline was truncated to local limits.")}</footer>}
  </section>;
}
