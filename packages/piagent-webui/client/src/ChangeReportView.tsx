import { useEffect, useState, type ReactNode } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import CloseRounded from "@mui/icons-material/CloseRounded";
import OpenInFullRounded from "@mui/icons-material/OpenInFullRounded";

import type { PiagentWebUIChangeReportScreenshotV1 as Asset } from "../../contracts/generated/document-asset-v1.ts";
import { readInspectionJson } from "./api.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

// A front-end change report written by the fe-change-report skill: report.json
// beside a shots/ folder of before/after screenshots. The dashboard draws it
// from data. Every field is shown as text and every frame is a positioned span,
// so the report carries no markup of its own into the page. Images come through
// the document read model as PNG bytes and are only ever drawn by <img>.

export const CHANGE_REPORT_KIND = "fe-change-report";

type Box = { n?: number; x: number; y: number; w: number; h: number; text?: string; before?: Box; after?: Box };
type Section = { key: string; title?: string; note?: string; viewport?: string; boxes?: Box[]; otherBoxes?: Record<string, Box[]> };
type Change = { title?: string; before?: string; after?: string; impact?: string; files?: string[] };
type Check = { name?: string; result?: string; detail?: string };
export type ChangeReport = {
  kind: typeof CHANGE_REPORT_KIND; title?: string; lede?: string; base?: string; head?: string; viewports?: string[];
  summary?: string[]; business?: Change[]; logic?: Change[]; sections?: Section[];
  e2e?: Check & { command?: string; passed?: number; failed?: number; skipped?: number; duration?: string; notes?: string[] };
  checks?: Check[]; files?: Array<{ path?: string; kind?: string; summary?: string }>; risks?: string[];
};

const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const array = <T,>(value: unknown): T[] => (Array.isArray(value) ? value.slice(0, 200) as T[] : []);
const text = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

export function parseChangeReport(source: string): ChangeReport | null {
  try {
    const value = JSON.parse(source) as ChangeReport;
    return value && typeof value === "object" && value.kind === CHANGE_REPORT_KIND ? value : null;
  } catch { return null; }
}

function validBox(box: Box | undefined): box is Box {
  return Boolean(box) && [box!.x, box!.y, box!.w, box!.h].every((value) => Number.isFinite(value) && value >= 0) && box!.w > 0 && box!.h > 0;
}

type Loaded = { state: "loading" | "missing" } | { state: "ready"; src: string; width: number; height: number };
const cache = new Map<string, Promise<Loaded>>();

function loadAsset(sessionRef: string | null, documentRef: string, name: string): Promise<Loaded> {
  const key = `${sessionRef ?? ""}\u0000${documentRef}\u0000${name}`;
  if (!cache.has(key)) {
    cache.set(key, readInspectionJson<Asset>(sessionRef, `/api/v1/documents/${encodeURIComponent(documentRef)}/assets/${encodeURIComponent(name)}`)
      .then(async (asset): Promise<Loaded> => {
        if (asset.state !== "ready" || !asset.base64) return { state: "missing" };
        const src = `data:image/png;base64,${asset.base64}`, image = new Image();
        image.src = src; await image.decode();
        return { state: "ready", src, width: image.naturalWidth, height: image.naturalHeight };
      })
      .catch(() => { cache.delete(key); return { state: "missing" }; }));
    // Keep the cache small: one report's screenshots, not every report opened today.
    if (cache.size > 48) cache.delete(cache.keys().next().value!);
  }
  return cache.get(key)!;
}

function useAsset(sessionRef: string | null, documentRef: string, name: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let live = true; setLoaded({ state: "loading" });
    void loadAsset(sessionRef, documentRef, name).then((value) => { if (live) setLoaded(value); });
    return () => { live = false; };
  }, [sessionRef, documentRef, name]);
  return loaded;
}

const pct = (part: number, whole: number) => `${Math.max(0, Math.min(100, part / whole * 100))}%`;

function clamp(box: Box, image: { width: number; height: number }): Box {
  const x = Math.min(box.x, image.width - 1), y = Math.min(box.y, image.height - 1);
  return { ...box, x, y, w: Math.min(box.w, image.width - x), h: Math.min(box.h, image.height - y) };
}

type Frame = { n: number; box: Box };

function Shot({ asset, label, frames, locale }: { asset: Loaded; label: string; frames: Frame[]; locale: UiLocale }) {
  return <figure className="change-report-figure">
    <figcaption>{label}</figcaption>
    {asset.state === "ready"
      ? <div className="change-report-shot">
        <img src={asset.src} alt={label} />
        {frames.map(({ n, box }) => {
          const fit = clamp(box, asset);
          return <span key={n} className="change-report-box" style={{ left: pct(fit.x, asset.width), top: pct(fit.y, asset.height),
            width: pct(fit.w, asset.width), height: pct(fit.h, asset.height) }}><b>{n}</b></span>;
        })}
      </div>
      : <p className="change-report-missing">{asset.state === "loading" ? localize(locale, "Đang tải ảnh…", "Loading the screenshot…")
        : localize(locale, "Không có ảnh", "No screenshot")}</p>}
  </figure>;
}

function Zoom({ asset, box, label }: { asset: Loaded; box: Box; label: string }) {
  if (asset.state !== "ready") return null;
  const fit = clamp(box, asset);
  const left = asset.width === fit.w ? 0 : fit.x / (asset.width - fit.w) * 100;
  const top = asset.height === fit.h ? 0 : fit.y / (asset.height - fit.h) * 100;
  return <div className="change-report-zoom"><span>{label}</span>
    <div role="img" aria-label={label} className="change-report-crop" style={{ maxWidth: Math.round(fit.w * 2.5), aspectRatio: `${fit.w} / ${fit.h}`,
      backgroundImage: `url("${asset.src}")`, backgroundSize: `${asset.width / fit.w * 100}% auto`, backgroundPosition: `${left}% ${top}%` }} /></div>;
}

function SectionView({ section, viewports, sessionRef, documentRef, locale }: {
  section: Section; viewports: string[]; sessionRef: string | null; documentRef: string; locale: UiLocale;
}) {
  const viewport = KEY.test(text(section.viewport)) ? text(section.viewport) : viewports[0];
  const before = useAsset(sessionRef, documentRef, `before-${section.key}-${viewport}.png`);
  const after = useAsset(sessionRef, documentRef, `after-${section.key}-${viewport}.png`);
  const [pixels, setPixels] = useState(false);
  const boxes = array<Box>(section.boxes).filter(validBox).map((box, index) => ({ ...box, n: Number.isInteger(box.n) ? box.n! : index + 1 }));
  const side = (key: "before" | "after"): Frame[] => boxes.map((box) => ({ n: box.n, box: validBox(box[key]) ? box[key]! : box }));
  const [oldLabel, newLabel] = [localize(locale, "Cũ", "Before"), localize(locale, "Mới", "After")];
  return <section className="change-report-card">
    <h4>{text(section.title) || section.key}</h4>
    {section.note && <p className="change-report-note">{text(section.note)}</p>}
    <div className="change-report-pair">
      <Shot asset={before} label={`${oldLabel} · ${viewport}`} frames={side("before")} locale={locale} />
      <Shot asset={after} label={`${newLabel} · ${viewport}`} frames={side("after")} locale={locale} />
    </div>
    {boxes.length > 0 && <h5>{localize(locale, "Phóng to theo số", "Zoom by number")}</h5>}
    {boxes.map((box) => <div className="change-report-zoom-row" key={box.n}>
      <p><b className="change-report-number">{box.n}</b> {text(box.text)}</p>
      <div className="change-report-pair">
        <Zoom asset={before} box={validBox(box.before) ? box.before : box} label={oldLabel} />
        <Zoom asset={after} box={validBox(box.after) ? box.after : box} label={newLabel} />
      </div>
    </div>)}
    {viewports.filter((name) => name !== viewport).map((name) => <OtherViewport key={name} name={name} section={section}
      sessionRef={sessionRef} documentRef={documentRef} locale={locale} />)}
    <details onToggle={(event) => setPixels((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{localize(locale, "Pixel khác nhau (tô đỏ trên ảnh mới)", "Changed pixels (red on the new screenshot)")}</summary>
      {pixels && <DiffImage name={`diff-${section.key}-${viewport}.png`} sessionRef={sessionRef} documentRef={documentRef} locale={locale} />}
    </details>
  </section>;
}

function DiffImage({ name, sessionRef, documentRef, locale }: { name: string; sessionRef: string | null; documentRef: string; locale: UiLocale }) {
  return <Shot asset={useAsset(sessionRef, documentRef, name)} label={localize(locale, "Khác biệt", "Difference")} frames={[]} locale={locale} />;
}

function OtherViewport({ name, section, sessionRef, documentRef, locale }: {
  name: string; section: Section; sessionRef: string | null; documentRef: string; locale: UiLocale;
}) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>{localize(locale, "Khổ khác", "Other size")}: {name}</summary>
    {open && <OtherPair name={name} section={section} sessionRef={sessionRef} documentRef={documentRef} locale={locale} />}
  </details>;
}

function OtherPair({ name, section, sessionRef, documentRef, locale }: {
  name: string; section: Section; sessionRef: string | null; documentRef: string; locale: UiLocale;
}) {
  const before = useAsset(sessionRef, documentRef, `before-${section.key}-${name}.png`);
  const after = useAsset(sessionRef, documentRef, `after-${section.key}-${name}.png`);
  const frames = array<Box>(section.otherBoxes?.[name]).filter(validBox).map((box, index) => ({ n: Number.isInteger(box.n) ? box.n! : index + 1, box }));
  return <div className="change-report-pair narrow">
    <Shot asset={before} label={`${localize(locale, "Cũ", "Before")} · ${name}`} frames={frames} locale={locale} />
    <Shot asset={after} label={`${localize(locale, "Mới", "After")} · ${name}`} frames={frames} locale={locale} />
  </div>;
}

function ChangeTable({ rows, last, locale }: { rows: Change[]; last: "impact" | "files"; locale: UiLocale }) {
  return <div className="change-report-scroll"><table className="change-report-table">
    <thead><tr><th>{localize(locale, "Mục", "Item")}</th><th>{localize(locale, "Cũ", "Before")}</th><th>{localize(locale, "Mới", "After")}</th>
      <th>{last === "impact" ? localize(locale, "Ảnh hưởng", "Impact") : localize(locale, "File", "Files")}</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}><td><strong>{text(row.title)}</strong></td><td>{text(row.before)}</td><td>{text(row.after)}</td>
      <td>{last === "impact" ? text(row.impact) : array<string>(row.files).map((file) => <code key={file}>{text(file)}</code>)}</td></tr>)}</tbody>
  </table></div>;
}

function Result({ value, locale }: { value: unknown; locale: UiLocale }) {
  const kind = value === "passed" || value === "failed" ? value : "skipped";
  return <span className={`change-report-result ${kind}`}>{kind === "passed" ? localize(locale, "Đạt", "Passed")
    : kind === "failed" ? localize(locale, "Lỗi", "Failed") : localize(locale, "Bỏ qua", "Skipped")}</span>;
}

// The document viewer sits beside the file list, which leaves screenshots small.
// Full screen shows the same report at the width it was captured for.
export function ChangeReportView(props: { report: ChangeReport; sessionRef: string | null; documentRef: string }) {
  const { locale } = useUiPreferences();
  const [full, setFull] = useState(false);
  return <>
    <div className="change-report-actions">
      <Button size="small" variant="outlined" startIcon={<OpenInFullRounded fontSize="small" />} onClick={() => setFull(true)}>
        {localize(locale, "Xem toàn màn hình", "Full screen")}</Button>
    </div>
    {!full && <ReportBody {...props} />}
    <Dialog fullScreen open={full} onClose={() => setFull(false)} aria-label={localize(locale, "Báo cáo thay đổi giao diện", "Front-end change report")}>
      <div className="change-report-full">
        <IconButton className="change-report-close" onClick={() => setFull(false)} aria-label={localize(locale, "Đóng toàn màn hình", "Close full screen")}>
          <CloseRounded /></IconButton>
        {full && <ReportBody {...props} />}
      </div>
    </Dialog>
  </>;
}

function ReportBody({ report, sessionRef, documentRef }: { report: ChangeReport; sessionRef: string | null; documentRef: string }) {
  const { locale } = useUiPreferences();
  const viewports = array<string>(report.viewports).filter((name) => KEY.test(text(name)));
  if (viewports.length === 0) viewports.push("desktop", "mobile");
  const sections = array<Section>(report.sections).filter((section) => KEY.test(text(section?.key)));
  const e2e = report.e2e;
  const checks: Check[] = [...(e2e ? [{ name: `E2E${e2e.command ? ` · ${text(e2e.command)}` : ""}`, result: e2e.result,
    detail: [e2e.passed !== undefined && `${text(e2e.passed)} ${localize(locale, "đạt", "passed")}`, e2e.failed && `${text(e2e.failed)} ${localize(locale, "lỗi", "failed")}`,
      e2e.skipped && `${text(e2e.skipped)} ${localize(locale, "bỏ qua", "skipped")}`, text(e2e.duration), ...array<string>(e2e.notes).map(text)].filter(Boolean).join(" · ") }] : []),
  ...array<Check>(report.checks)];
  const block = (title: string, body: ReactNode, show: boolean) => show && <section className="change-report-block"><h3>{title}</h3>{body}</section>;
  return <div className="change-report">
    <header><h2>{text(report.title) || localize(locale, "Báo cáo thay đổi giao diện", "Front-end change report")}</h2>
      {report.lede && <p className="change-report-note">{text(report.lede)}</p>}
      <div className="change-report-chips">{report.base && <span>{localize(locale, "Cũ", "Before")}: {text(report.base)}</span>}
        {report.head && <span>{localize(locale, "Mới", "After")}: {text(report.head)}</span>}</div></header>
    {block(localize(locale, "Tóm tắt", "Summary"), <ul>{array<string>(report.summary).map((line, index) => <li key={index}>{text(line)}</li>)}</ul>, array(report.summary).length > 0)}
    {block(localize(locale, "Business thay đổi", "Business changes"), <ChangeTable rows={array(report.business)} last="impact" locale={locale} />, array(report.business).length > 0)}
    {block(localize(locale, "Logic thay đổi", "Logic changes"), <ChangeTable rows={array(report.logic)} last="files" locale={locale} />, array(report.logic).length > 0)}
    {block(localize(locale, "UI/UX cũ và mới", "UI/UX before and after"), sections.map((section) => <SectionView key={section.key} section={section}
      viewports={viewports} sessionRef={sessionRef} documentRef={documentRef} locale={locale} />), sections.length > 0)}
    {block(localize(locale, "Kiểm thử", "Verification"), <div className="change-report-scroll"><table className="change-report-table"><tbody>
      {checks.map((check, index) => <tr key={index}><td>{text(check.name)}</td><td><Result value={check.result} locale={locale} /></td><td>{text(check.detail)}</td></tr>)}
    </tbody></table></div>, checks.length > 0)}
    {block(localize(locale, "File đã đổi", "Changed files"), <div className="change-report-scroll"><table className="change-report-table"><tbody>
      {array<{ path?: string; kind?: string; summary?: string }>(report.files).map((file, index) => <tr key={index}><td><code>{text(file.path)}</code></td><td>{text(file.kind)}</td><td>{text(file.summary)}</td></tr>)}
    </tbody></table></div>, array(report.files).length > 0)}
    {block(localize(locale, "Rủi ro và việc còn lại", "Risks and follow-ups"), <ul>{array<string>(report.risks).map((line, index) => <li key={index}>{text(line)}</li>)}</ul>, array(report.risks).length > 0)}
  </div>;
}
