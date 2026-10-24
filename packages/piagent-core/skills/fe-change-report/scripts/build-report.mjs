#!/usr/bin/env node
// Builds one self-contained HTML report (no scripts, images embedded once) from
// report.json and the screenshots captured by capture.mjs.
//   node build-report.mjs --spec report.json --dir <shots dir> --out report.html
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, pngSize, SAFE_NAME } from "./capture.mjs";

export const REPORT_MARKER = "piagent-fe-change-report-v1";

const TEXT = {
  vi: {
    summary: "Tóm tắt", business: "Business thay đổi", logic: "Logic thay đổi", ui: "UI/UX cũ và mới", tests: "Kiểm thử",
    files: "File đã đổi", risks: "Rủi ro và việc còn lại", item: "Mục", before: "Cũ", after: "Mới", impact: "Ảnh hưởng",
    where: "File", zoom: "Phóng to theo số", other: "Khổ khác", pixels: "Pixel khác nhau (tô đỏ trên ảnh mới)",
    check: "Kiểm tra", result: "Kết quả", detail: "Chi tiết", passed: "Đạt", failed: "Lỗi", skipped: "Bỏ qua",
    generated: "Tạo lúc", missing: "Không có ảnh", e2e: "E2E", noChanges: "Không có thay đổi giao diện được ghi nhận."
  },
  en: {
    summary: "Summary", business: "Business changes", logic: "Logic changes", ui: "UI/UX before and after", tests: "Verification",
    files: "Changed files", risks: "Risks and follow-ups", item: "Item", before: "Before", after: "After", impact: "Impact",
    where: "Files", zoom: "Zoom by number", other: "Other sizes", pixels: "Changed pixels (red on the new screenshot)",
    check: "Check", result: "Result", detail: "Detail", passed: "Passed", failed: "Failed", skipped: "Skipped",
    generated: "Generated", missing: "No screenshot", e2e: "E2E", noChanges: "No visual change was recorded."
  }
};

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const percent = (value) => `${Number(value.toFixed(3))}%`;
const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);

function checkBox(box, image, where) {
  for (const key of ["x", "y", "w", "h"]) {
    if (!Number.isFinite(box[key]) || box[key] < 0) throw new Error(`${where}: box.${key} must be a non-negative number`);
  }
  if (box.w === 0 || box.h === 0) throw new Error(`${where}: box must have a width and height`);
  // Clamp rather than fail: a box drawn on the taller "after" page may run past a shorter "before" page.
  const x = Math.min(box.x, image.width - 1), y = Math.min(box.y, image.height - 1);
  return { x, y, w: Math.min(box.w, image.width - x), h: Math.min(box.h, image.height - y) };
}

class Images {
  #dir; #classes = new Map(); rules = [];
  constructor(dir) { this.#dir = dir; }
  get(name) {
    const file = path.join(this.#dir, `${name}.png`);
    if (!fs.existsSync(file)) return undefined;
    if (!this.#classes.has(name)) {
      const bytes = fs.readFileSync(file), id = `i${this.#classes.size}`;
      this.#classes.set(name, { id, ...pngSize(bytes) });
      this.rules.push(`.${id}{background-image:url(data:image/png;base64,${bytes.toString("base64")})}`);
    }
    return this.#classes.get(name);
  }
}

function shot(image, boxes, label, t) {
  if (!image) return `<figure><figcaption>${escape(label)}</figcaption><p class="missing">${t.missing}</p></figure>`;
  const frames = boxes.map(({ n, box }) => `<span class="box" style="left:${percent(box.x / image.width * 100)};top:${percent(box.y / image.height * 100)};width:${percent(box.w / image.width * 100)};height:${percent(box.h / image.height * 100)}"><b>${n}</b></span>`).join("");
  return `<figure><figcaption>${escape(label)}</figcaption><div class="shot ${image.id}" role="img" aria-label="${escape(label)}" style="aspect-ratio:${image.width}/${image.height}">${frames}</div></figure>`;
}

function crop(image, box, label) {
  if (!image) return "";
  const size = image.width / box.w * 100;
  const left = image.width === box.w ? 0 : box.x / (image.width - box.w) * 100;
  const top = image.height === box.h ? 0 : box.y / (image.height - box.h) * 100;
  // Past about 2.5x a screenshot only gets blurrier, so a small box stays small.
  return `<div class="zoom"><span class="zl">${escape(label)}</span><div class="crop ${image.id}" style="max-width:${Math.round(box.w * 2.5)}px;aspect-ratio:${box.w}/${box.h};background-size:${percent(size)} auto;background-position:${percent(left)} ${percent(top)}"></div></div>`;
}

function sectionHtml(section, images, viewports, t) {
  const viewport = section.viewport ?? viewports[0];
  // Keys and viewport names become file names; anything else could name a file outside the shots folder.
  for (const name of [section.key, viewport, ...Object.keys(section.otherBoxes ?? {})]) {
    if (!SAFE_NAME.test(String(name))) throw new Error(`section key and viewport names must match ${SAFE_NAME}: ${name}`);
  }
  const before = images.get(`before-${section.key}-${viewport}`), after = images.get(`after-${section.key}-${viewport}`);
  const boxes = list(section.boxes).map((box, index) => {
    const n = box.n ?? index + 1, where = `section ${section.key} box ${n}`;
    return {
      n, text: box.text,
      before: before && checkBox(box.before ?? box, before, where),
      after: after && checkBox(box.after ?? box, after, where)
    };
  });
  const pair = shot(before, boxes.map(({ n, before: box }) => ({ n, box })).filter(({ box }) => box), `${t.before} · ${viewport}`, t)
    + shot(after, boxes.map(({ n, after: box }) => ({ n, box })).filter(({ box }) => box), `${t.after} · ${viewport}`, t);
  const zooms = boxes.map((box) => `<div class="zrow"><p class="zt"><b class="num">${box.n}</b> ${escape(box.text)}</p><div class="pair">${box.before ? crop(before, box.before, t.before) : ""}${box.after ? crop(after, box.after, t.after) : ""}</div></div>`).join("");
  const others = viewports.filter((name) => name !== viewport).map((name) => {
    const oldShot = images.get(`before-${section.key}-${name}`), newShot = images.get(`after-${section.key}-${name}`);
    if (!oldShot && !newShot) return "";
    const otherBoxes = list(section.otherBoxes?.[name]).map((box, index) => ({ n: box.n ?? index + 1, box }));
    const fit = (image) => otherBoxes.filter(() => image).map(({ n, box }) => ({ n, box: checkBox(box, image, `section ${section.key} ${name}`) }));
    return `<details><summary>${t.other}: ${escape(name)}</summary><div class="pair narrow">${shot(oldShot, fit(oldShot), `${t.before} · ${name}`, t)}${shot(newShot, fit(newShot), `${t.after} · ${name}`, t)}</div></details>`;
  }).join("");
  const overlay = images.get(`diff-${section.key}-${viewport}`);
  const pixels = overlay ? `<details><summary>${t.pixels}</summary><div class="shot ${overlay.id}" role="img" aria-label="${escape(t.pixels)}" style="aspect-ratio:${overlay.width}/${overlay.height}"></div></details>` : "";
  return `<section class="card"><h3>${escape(section.title ?? section.key)}</h3>${section.note ? `<p class="note">${escape(section.note)}</p>` : ""}<div class="pair">${pair}</div>${zooms ? `<h4>${t.zoom}</h4>${zooms}` : ""}${others}${pixels}</section>`;
}

function table(headers, rows) {
  if (!rows.length) return "";
  return `<div class="scroll"><table><thead><tr>${headers.map((header) => `<th>${escape(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function badge(result, t) {
  const kind = ["passed", "failed", "skipped"].includes(result) ? result : "skipped";
  return `<span class="badge ${kind}">${escape(t[kind])}</span>`;
}

export const REPORT_KIND = "fe-change-report";

export function buildReport({ spec, dir }) {
  // The dashboard draws a report.json only when it says what it is.
  if (spec.kind !== REPORT_KIND) throw new Error(`report.json must have "kind": "${REPORT_KIND}"`);
  const t = TEXT[spec.lang === "en" ? "en" : "vi"];
  const meta = fs.existsSync(path.join(dir, "meta.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) : { shots: {} };
  const viewports = list(spec.viewports).length ? list(spec.viewports) : [...new Set(Object.values(meta.shots).map((entry) => entry.viewport))];
  for (const name of viewports) if (!SAFE_NAME.test(String(name))) throw new Error(`viewport names must match ${SAFE_NAME}: ${name}`);
  if (!viewports.length) viewports.push("desktop");
  const images = new Images(dir);
  const block = (title, body) => (body ? `<section class="block"><h2>${escape(title)}</h2>${body}</section>` : "");
  const changeRows = (items, last) => list(items).map((item) => [`<b>${escape(item.title)}</b>`, escape(item.before), escape(item.after), last(item)]);
  const tests = [
    ...(spec.e2e ? [[escape(`${t.e2e}${spec.e2e.command ? ` · ${spec.e2e.command}` : ""}`), badge(spec.e2e.result, t),
      escape([spec.e2e.passed !== undefined && `${spec.e2e.passed} ${t.passed.toLowerCase()}`, spec.e2e.failed && `${spec.e2e.failed} ${t.failed.toLowerCase()}`,
        spec.e2e.skipped && `${spec.e2e.skipped} ${t.skipped.toLowerCase()}`, spec.e2e.duration, ...list(spec.e2e.notes)].filter(Boolean).join(" · "))]] : []),
    ...list(spec.checks).map((check) => [escape(check.name), badge(check.result, t), escape(check.detail)])
  ];
  const files = list(spec.files).map((file) => [`<code>${escape(file.path)}</code>`, escape(file.kind), escape(file.summary)]);
  const sections = list(spec.sections).map((section) => sectionHtml(section, images, viewports, t)).join("");
  const chips = [spec.base && `${t.before}: ${spec.base}`, spec.head && `${t.after}: ${spec.head}`, `${t.generated}: ${spec.generatedAt ?? new Date().toISOString().slice(0, 16).replace("T", " ")}`]
    .filter(Boolean).map((chip) => `<span class="chip">${escape(chip)}</span>`).join("");
  const body = [
    `<header><h1>${escape(spec.title ?? "Front-end change report")}</h1>${spec.lede ? `<p class="lede">${escape(spec.lede)}</p>` : ""}<div class="chips">${chips}</div></header>`,
    block(t.summary, list(spec.summary).length ? `<ul>${list(spec.summary).map((line) => `<li>${escape(line)}</li>`).join("")}</ul>` : ""),
    block(t.business, table([t.item, t.before, t.after, t.impact], changeRows(spec.business, (item) => escape(item.impact)))),
    block(t.logic, table([t.item, t.before, t.after, t.where], changeRows(spec.logic, (item) => list(item.files).map((file) => `<code>${escape(file)}</code>`).join("<br>")))),
    block(t.ui, sections || `<p class="note">${t.noChanges}</p>`),
    block(t.tests, table([t.check, t.result, t.detail], tests)),
    block(t.files, table([t.where, t.item, t.detail], files)),
    block(t.risks, list(spec.risks).length ? `<ul>${list(spec.risks).map((line) => `<li>${escape(line)}</li>`).join("")}</ul>` : "")
  ].join("");
  return `<!doctype html>
<html lang="${spec.lang === "en" ? "en" : "vi"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="${REPORT_MARKER}"><title>${escape(spec.title ?? "Front-end change report")}</title>
<style>${STYLE}${images.rules.join("")}</style></head><body><main>${body}</main></body></html>
`;
}

const STYLE = `
:root{--bg:#f6f7f5;--fg:#1b1f1d;--muted:#5d6762;--card:#fff;--line:#d9dfdb;--mark:#d4202a;--on-mark:#fff;--ok:#0b7a3e;--bad:#c62828;--skip:#8a6d00;
--sans:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141816;--fg:#e8ece9;--muted:#9fa9a4;--card:#1d2320;--line:#323a36;--mark:#ff5a5f;--ok:#5ccf8f;--bad:#ff7a7a;--skip:#e0c25c;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans);padding:24px 16px 48px}
main{max-width:1180px;margin:0 auto;display:grid;gap:28px}h1{font-size:1.6rem;margin:0 0 6px}h2{font-size:1.2rem;margin:0 0 12px}
h3{font-size:1.05rem;margin:0 0 4px}h4{font-size:.78rem;margin:18px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.lede,.note{color:var(--muted);max-width:75ch;margin:0 0 12px}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:.82rem;color:var(--muted)}
.block>ul{margin:0;padding-left:20px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:16px}.pair.narrow{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),390px))}
figure{margin:0;min-width:0}figcaption{font-weight:700;margin-bottom:6px}.missing{color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:24px;text-align:center}
.shot{position:relative;width:100%;border:1px solid var(--line);border-radius:8px;background-size:100% auto;background-repeat:no-repeat}
.box{position:absolute;border:3px solid var(--mark);border-radius:4px}
.box b,.num{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--mark);color:var(--on-mark);font-size:.8rem;line-height:1;flex:none}
.box b{position:absolute;top:-12px;left:-12px;box-shadow:0 0 0 2px var(--card)}.zrow{display:grid;gap:8px;margin-bottom:14px}.zt{margin:0;display:flex;gap:8px;align-items:center}
.zoom{min-width:0}.zl{font-size:.8rem;color:var(--muted)}.crop{width:100%;border:3px solid var(--mark);border-radius:6px;background-repeat:no-repeat}
details{margin-top:14px}summary{cursor:pointer;font-weight:600}details>.shot,details>.pair{margin-top:10px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{font-size:.82rem;color:var(--muted)}
code{font-size:.85em;word-break:break-all}.badge{font-weight:700;font-size:.82rem}.badge.passed{color:var(--ok)}.badge.failed{color:var(--bad)}.badge.skipped{color:var(--skip)}
`.trim();

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.spec || !options.dir || !options.out) { console.error("usage: build-report.mjs --spec report.json --dir <shots dir> --out report.html"); process.exit(2); }
  const html = buildReport({ spec: JSON.parse(fs.readFileSync(options.spec, "utf8")), dir: options.dir });
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, html);
  console.log(`${options.out} ${Math.round(html.length / 1024)} KB`);
}
