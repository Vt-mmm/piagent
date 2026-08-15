import { useCallback, useEffect, useRef, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedBenchmarkAndReleaseMonitorV1 } from "../../contracts/generated/release-monitor-v1.ts";
import { readReleaseMonitor } from "./api.ts";
import { label, tone } from "./view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

function localTime(value: string | null, locale: "vi" | "en"): string {
  if (!value) return localize(locale, "Chưa có", "Not available");
  try { return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

function Status({ value, locale }: { value: string; locale: "vi" | "en" }) {
  return <span className={`status-pill tone-${tone(value)}`}><span aria-hidden="true" className="status-dot" />{label(value, locale)}</span>;
}

export function ReleaseMonitorPanel({ snapshot }: { snapshot: PiagentWebUICanonicalSnapshotV1 }) {
  const { locale } = useUiPreferences();
  const [monitor, setMonitor] = useState<PiagentWebUIBoundedBenchmarkAndReleaseMonitorV1>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const request = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setState("loading");
    void readReleaseMonitor(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setMonitor(value); setState("ready"); }
    }).catch(() => { if (!controller.signal.aborted) setState("error"); });
  }, []);
  useEffect(() => { load(); return () => request.current?.abort(); }, [load, snapshot.identity.projectRef, snapshot.identity.runtimeInstanceId]);

  return <section className="release-monitor surface" aria-labelledby="release-monitor-title">
    <header className="source-heading"><div><p className="section-kicker">Benchmark & release</p><h2 id="release-monitor-title">{localize(locale, "Theo dõi chất lượng và mức sẵn sàng phát hành", "Quality and release readiness")}</h2></div>
      <button type="button" onClick={load} disabled={state === "loading"}>{state === "loading" ? localize(locale, "Đang đọc…", "Loading…") : localize(locale, "Làm mới", "Refresh")}</button></header>
    <p className="retained-content-note">{localize(locale, "Màn hình chỉ đọc bằng chứng local; không tự chạy benchmark, resume, commit, tag, publish hay push.", "This screen only reads local evidence; it never runs benchmarks, resumes, commits, tags, publishes, or pushes.")}</p>
    {(state === "error" || monitor?.state === "unavailable") && <p className="task-index-empty error-state">{localize(locale, "Bằng chứng benchmark/release chưa sẵn sàng; Pi session hiện tại không bị ảnh hưởng.", "Benchmark and release evidence is unavailable; the current Pi session is unaffected.")}</p>}
    {state === "loading" && !monitor && <p className="task-index-empty">{localize(locale, "Đang xác minh report, manifest và ledger…", "Verifying reports, manifests, and ledgers…")}</p>}
    {monitor && <div className="release-monitor-grid">
      <section className="release-monitor-column" aria-labelledby="benchmark-monitor-title">
        <header><div><p className="section-kicker">Benchmark runs</p><h3 id="benchmark-monitor-title">{localize(locale, "Các lần đo gần đây", "Recent runs")}</h3></div><Status value={monitor.benchmark.state} locale={locale} /></header>
        {monitor.benchmark.runs.map((run) => <article className="benchmark-run-card" key={run.runRef}>
          <div><strong>{run.suiteId}</strong><Status value={run.lifecycle} locale={locale} /></div>
          <small>{localTime(run.updatedAt, locale)} · {run.completedRuns}/{run.expectedRuns} {localize(locale, "lượt", "runs")} · {localize(locale, "nguồn", "source")} {label(run.sourceState, locale)}</small>
          <div className="benchmark-run-facts"><span>Gate <b>{label(run.releaseGate, locale)}</b></span><span>{localize(locale, "Điểm", "Score")} <b>{run.scores.overall ?? "—"}</b></span>
            <span>Claim <b>{label(run.claimTier, locale)}</b></span></div>
        </article>)}
        {monitor.benchmark.runs.length === 0 && <p className="task-index-empty">{localize(locale, "Chưa có run thuộc repo hiện tại với bằng chứng đủ tin cậy.", "No trustworthy runs are available for the current repository.")}</p>}
        {monitor.benchmark.warnings.map((warning) => <p className="task-index-warning" role="status" key={warning.code}>{warning.message}</p>)}
        {monitor.benchmark.page.truncated && <p className="task-index-warning">{localize(locale, "Danh sách được giới hạn để giữ WebUI nhẹ và ổn định.", "The list is bounded to keep WebUI fast and stable.")}</p>}
      </section>
      <section className="release-monitor-column" aria-labelledby="release-readiness-title">
        <header><div><p className="section-kicker">Release readiness</p><h3 id="release-readiness-title">{localize(locale, "RC hiện tại", "Current RC")}</h3></div><Status value={monitor.release.state} locale={locale} /></header>
        <dl className="release-readiness-facts">
          <div><dt>Local safe gate</dt><dd><Status value={monitor.release.localSafeGate} locale={locale} /></dd></div>
          <div><dt>RC assembly</dt><dd>{label(monitor.release.rcAssembly, locale)}</dd></div>
          <div><dt>Beta</dt><dd>{label(monitor.release.beta, locale)}</dd></div>
          <div><dt>GA</dt><dd>{label(monitor.release.gaRelease, locale)}</dd></div>
          <div><dt>{localize(locale, "Báo cáo", "Report")}</dt><dd>{localTime(monitor.release.generatedAt, locale)}</dd></div>
        </dl>
        {monitor.release.sourceState === "stale" && <p className="task-index-warning">{localize(locale, "Báo cáo RC thuộc phiên bản source cũ; không dùng để xác nhận tree hiện tại.", "The RC report belongs to an older source revision and cannot validate the current tree.")}</p>}
        {monitor.release.blockers.length > 0 && <div className="release-blockers"><strong>{monitor.release.blockerCount} blocker</strong><ul>
          {monitor.release.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}</ul></div>}
        <p className="retained-content-note">{localize(locale, "Mọi quyền phát hành đều tắt. Việc phát hành vẫn cần operator phê duyệt ngoài màn hình này.", "All release authority is disabled. Release still requires operator approval outside this screen.")}</p>
      </section>
    </div>}
  </section>;
}
