#!/usr/bin/env node
// Generates the legacy-migration material of the node-postgres-long fixture,
// deterministically (same output on every run):
//   project/data/legacy-bookings.csv   ~20,000 rows exported by the old system,
//                                      50 of them bad (unknown rooms, bad
//                                      times, overlaps inside the file)
//   project/legacy/import-old.js       the old ~3,000-line import script whose
//                                      rules the new importer must follow
//   hidden-p5/test/legacy-expected.json ground truth for the hidden p5 test
// The ground truth comes from the generator's own model of each row, not from
// parsing the file, so it checks the reference importer independently.
//   node generate/gen-legacy.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let seed = 20270104;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = list => list[Math.floor(rnd() * list.length)];
const chance = p => rnd() < p;
const pad = (n, w = 2) => String(n).padStart(w, '0');

// ---- the old system's room catalogue -------------------------------------
const ROOMS = {
  P101: ['Phòng Sen', 8], P102: ['Phòng Mai', 6], P103: ['Phòng Đào', 6],
  P201: ['Phòng Cúc', 10], P202: ['Phòng Lan', 12], P203: ['Phòng Trúc', 4],
  P301: ['Phòng Đào Tạo', 40], P302: ['Phòng Giám Đốc', 8],
  HTA: ['Hội trường A', 300], HTB: ['Hội trường B', 150],
  PN1: ['Phòng Họp Nhỏ 1', 3], PN2: ['Phòng Họp Nhỏ 2', 3],
};
const ALIASES = { 'HOI TRUONG A': 'HTA', 'HOI TRUONG B': 'HTB', 'PHONG SEN': 'P101', 'PHN1': 'PN1', 'PHN2': 'PN2', 'GIAM DOC': 'P302' };
const ALIAS_OF = { HTA: ['HT-A', 'Hoi truong A', 'HT.A'], HTB: ['HT-B', 'hoi truong b'], P101: ['Phong Sen'], PN1: ['PHN1', 'pn-1'], PN2: ['phn2'], P302: ['Giam doc'] };
const CODES = Object.keys(ROOMS);

// ---- row model ------------------------------------------------------------
const LOCAL = 7; // Asia/Ho_Chi_Minh
const utc = (y, m, d, minutes) => new Date(Date.UTC(y, m - 1, d, 0, minutes) - LOCAL * 3600_000);
const TITLES = ['Họp giao ban tuần', 'Review sprint', 'Phỏng vấn ứng viên', 'Đào tạo nội bộ', 'Họp khách hàng', 'Kế hoạch quý', 'Demo sản phẩm',
  'Họp phòng kế toán', 'Daily standup', 'Retro sprint', 'Họp HĐQT', 'Training an toàn PCCC', 'Họp dự án ERP', 'Workshop UX', 'Họp nhà cung cấp',
  '1:1 với quản lý', 'Họp tổng kết tháng', 'Họp ban giám đốc', 'Onboarding nhân viên mới', 'Thảo luận ngân sách'];
const ENTITY_TITLES = [['Họp R&amp;D', 'Họp R&D'], ['Q&amp;A với khách hàng', 'Q&A với khách hàng'], ['Review &quot;Dự án Xanh&quot;', 'Review "Dự án Xanh"'],
  ['Họp team &lt;Backend&gt;', 'Họp team <Backend>'], ['Kế hoạch &#39;2028&#39;', "Kế hoạch '2028'"], ['Sales &amp; Marketing', 'Sales & Marketing']];
const SEMI_TITLES = ['Họp; chốt hợp đồng', 'Review; demo; retro', 'Đào tạo Excel; nâng cao'];
const QUOTE_TITLES = ['Dự án "Mặt Trời"', 'Họp "khẩn"'];
const PEOPLE = ['an.nguyen', 'binh.tran', 'chi.le', 'dung.pham', 'giang.vo', 'hoa.dang', 'khanh.bui', 'linh.do', 'minh.ho', 'nam.ngo', 'oanh.duong', 'phuc.ly', 'quang.mai', 'son.truong', 'thao.vu', 'uyen.dinh'];

const rows = []; // { fields: [...9], truth } in file order
let nextId = 1;
const legacyId = () => `DP-${pad(nextId++, 6)}`;

function dateText(y, m, d, style) {
  if (style === 'iso') return `${y}-${pad(m)}-${pad(d)}`;
  if (style === 'short') return `${d}/${m}/${y}`;
  return `${pad(d)}/${pad(m)}/${y}`;
}
function timeText(minutes, style) {
  const h = Math.floor(minutes / 60), mi = minutes % 60;
  if (style === 'h') return mi ? `${h}h${pad(mi)}` : `${h}h`;
  if (style === 'short') return `${h}:${pad(mi)}`;
  if (style === 'sec') return `${pad(h)}:${pad(mi)}:00`;
  return `${pad(h)}:${pad(mi)}`;
}
const marks = {}; // quirk → first legacy id showing it (samples for the hidden test)
const mark = (quirk, id) => { marks[quirk] ??= id; };

function codeText(code, id) {
  const r = rnd();
  if (r < 0.08 && /^P\d{3}$/.test(code)) { mark('room code with a dot', id); return `P.${code.slice(1)}`; }
  if (r < 0.16) { mark('room code lower case with spaces', id); return ` ${code.toLowerCase()} `; }
  if (r < 0.26 && ALIAS_OF[code]) { const a = pick(ALIAS_OF[code]); mark(`room alias ${a}`, id); return a; }
  return code;
}

function validRow({ code, y, m, d, start, end, cancelled = false, forceStatus, forceCodeText, forceTimeStyle }) {
  const id = legacyId();
  const ds = rnd() < 0.8 ? 'dd' : pick(['short', 'iso']);
  if (ds !== 'dd') mark(`date style ${ds}`, id);
  const tstyle = forceTimeStyle ?? (rnd() < 0.8 ? 'hm' : pick(['h', 'short', 'sec']));
  if (tstyle !== 'hm') mark(`time style ${tstyle}`, id);
  let endText = timeText(end, tstyle);
  if (end === 24 * 60) { endText = '24:00'; mark('end 24:00', id); }
  // title
  let titleRaw, title;
  const tr = rnd();
  if (tr < 0.04) { [titleRaw, title] = pick(ENTITY_TITLES); mark('html entity title', id); }
  else if (tr < 0.06) { title = titleRaw = pick(SEMI_TITLES); mark('title with semicolon', id); }
  else if (tr < 0.07) { title = titleRaw = pick(QUOTE_TITLES); mark('title with quotes', id); }
  else if (tr < 0.075) { titleRaw = pick(['', '   ']); title = '(không tiêu đề)'; mark('empty title', id); }
  else { const t = pick(TITLES); titleRaw = chance(0.05) ? `  ${t} ` : t; title = t; }
  // organizer
  let orgRaw, organizer;
  const who = pick(PEOPLE), or = rnd();
  if (or < 0.4) { const [g, f] = who.split('.'); orgRaw = `${g[0].toUpperCase()}${g.slice(1)}.${f[0].toUpperCase()}${f.slice(1)}@congty.vn`; organizer = who; mark('email organizer', id); }
  else if (or < 0.43) { orgRaw = ''; organizer = 'khong-ro'; mark('empty organizer', id); }
  else if (or < 0.5) { orgRaw = ` ${who.toUpperCase()} `; organizer = who; mark('upper-case organizer', id); }
  else { orgRaw = who; organizer = who; }
  // status
  let status, cancelText = '', cancelledAt = null;
  const startsAt = utc(y, m, d, start), endsAt = utc(y, m, d, end);
  if (cancelled) {
    status = forceStatus ?? pick(['HUY', 'HUY', 'DA_HUY', 'CANCEL']);
    if (status !== 'HUY') mark(`cancel status ${status}`, id);
    if (chance(0.75)) {
      // cancelled 1–5 days before the start, at a local office hour
      const back = 1 + Math.floor(rnd() * 5), at = new Date(Date.UTC(y, m - 1, d - back));
      const cm = 8 * 60 + Math.floor(rnd() * 20) * 30;
      cancelText = `${pad(at.getUTCDate())}/${pad(at.getUTCMonth() + 1)}/${at.getUTCFullYear()} ${timeText(cm, 'hm')}`;
      cancelledAt = utc(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), cm);
      mark('cancelled with ngay_huy', id);
    } else { cancelledAt = startsAt; mark('cancelled without ngay_huy', id); }
  } else {
    status = forceStatus ?? (rnd() < 0.7 ? 'OK' : pick(['', 'XAC_NHAN', 'DA_DUYET']));
    if (status !== 'OK') mark(`active status ${status || '(empty)'}`, id);
  }
  const fields = [id, forceCodeText ?? codeText(code, id), dateText(y, m, d, ds), timeText(start, tstyle), endText, titleRaw, orgRaw, status, cancelText];
  return { fields, truth: { legacyId: id, room: ROOMS[code][0], code, startsAt, endsAt, title, organizer, cancelled, cancelledAt } };
}

// ---- 1. ordinary bookings: per working day, per room, non-overlapping slots
const TARGET_VALID = 19_950;
const valid = [];
const day0 = Date.UTC(2027, 0, 4);
for (let n = 0; valid.length < TARGET_VALID - 40; n++) {
  const day = new Date(day0 + n * 86400_000), wd = day.getUTCDay();
  if (wd === 0 || wd === 6) continue;
  const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
  for (const code of CODES) {
    if (chance(0.25)) continue;
    let t = 8 * 60 + pick([0, 0, 30, 60]);
    for (;;) {
      const dur = pick([30, 60, 60, 60, 90, 120]);
      if (t + dur > 18 * 60) break;
      if (chance(0.62)) valid.push(validRow({ code, y, m, d, start: t, end: t + dur, cancelled: chance(0.12) }));
      t += dur + pick([0, 0, 30, 60, 90]);
    }
    // evening events in the halls, ending at midnight (24:00)
    if ((code === 'HTA' || code === 'HTB') && wd === 5 && chance(0.5)) valid.push(validRow({ code, y, m, d, start: 19 * 60, end: 24 * 60, forceTimeStyle: 'hm' }));
    if (valid.length >= TARGET_VALID - 40) break;
  }
}

const active = () => valid.filter(r => !r.truth.cancelled);
const overlaps = (a, b) => a.truth.code === b.truth.code && a.truth.startsAt < b.truth.endsAt && b.truth.startsAt < a.truth.endsAt;
const fieldsDate = r => { const s = new Date(r.truth.startsAt.getTime() + LOCAL * 3600_000); return [s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate(), s.getUTCHours() * 60 + s.getUTCMinutes()]; };

// ---- 2. cancelled rows that overlap active ones (fine: cancelled rows never conflict)
const extras = []; // [afterIndex, row]
for (let k = 0; k < 40; k++) {
  const i = Math.floor(rnd() * valid.length), base = valid[i];
  if (base.truth.cancelled || base.truth.endsAt - base.truth.startsAt < 3600_000) { k--; continue; }
  const [y, m, d, s] = fieldsDate(base);
  const row = validRow({ code: base.truth.code, y, m, d, start: s + 30, end: s + 60, cancelled: true });
  mark('cancelled row overlapping an active row', row.truth.legacyId);
  extras.push([i, row]);
}

// ---- 3. bad rows (each with exactly one problem)
const bad = []; // [afterIndex, row, reason]
function badRow(reason, mutate) {
  const i = 100 + Math.floor(rnd() * (valid.length - 200)), base = valid[i];
  const [y, m, d, s] = fieldsDate(base);
  const row = validRow({ code: base.truth.code, y, m, d, start: s, end: s + 30, forceTimeStyle: 'hm', cancelled: false, forceStatus: 'OK' });
  mutate(row, base);
  row.truth = { legacyId: row.fields[0], problem: reason };
  bad.push([i, row, reason]);
}
for (const code of ['P777', 'P999', 'XYZ', '', 'P10', 'KHO', 'P 1 0 4', 'HT-C', 'P999', 'Phong Hoa', 'P401', '???']) badRow('UNKNOWN_ROOM', r => { r.fields[1] = code; });
const badTimes = [
  ['31/02/2027', null, null], ['30/02/2028', null, null], ['2027-13-05', null, null], ['', null, null], ['12/2027', null, null], ['32/01/2028', null, null],
  ['29/02/2027', null, null], ['2028-02-30', null, null], ['00/05/2027', null, null],
  [null, '25:00', null], [null, '9:75', null], [null, 'abc', null], [null, '24:00', null], [null, '', null], [null, '9h75', null], [null, '10:30:15', null],
  [null, null, '24:30'], [null, null, 'x'], [null, null, ''], [null, null, '18:60'],
  [null, '10:00', '09:00'], [null, '14:00', '14:00'], [null, '16h', '15h30'], [null, '11:00', '10:59'], [null, '08:30', '08:00'],
];
for (const [date, start, end] of badTimes) badRow('INVALID_TIME', r => { if (date !== null) r.fields[2] = date; if (start !== null) r.fields[3] = start; if (end !== null) r.fields[4] = end; });
// overlaps inside the file: a later active row in the same room overlapping an earlier active one
const overlapRows = [];
for (let k = 0; k < 13; k++) {
  const i = 200 + Math.floor(rnd() * (valid.length - 400)), base = valid[i];
  if (base.truth.cancelled || base.truth.endsAt - base.truth.startsAt < 3600_000 || base.truth.endsAt.getUTCHours() === 17) { k--; continue; }
  const [y, m, d, s] = fieldsDate(base);
  const shift = pick([0, 15, 30]);
  const row = validRow({ code: base.truth.code, y, m, d, start: s + shift, end: s + shift + 45, forceStatus: pick(['OK', 'XAC_NHAN', '']),
    forceCodeText: k % 3 === 0 && ALIAS_OF[base.truth.code] ? ALIAS_OF[base.truth.code][0] : k % 3 === 1 ? ` ${base.truth.code.toLowerCase()}` : undefined });
  row.truth = { legacyId: row.fields[0], problem: 'LEGACY_OVERLAP', overlapsWith: base.truth.legacyId };
  bad.push([i, row, 'LEGACY_OVERLAP']);
  overlapRows.push(row);
}

// ---- assemble in file order: extras and bad rows a little after their base row
const after = new Map();
for (const [i, row] of [...extras, ...bad]) { const at = Math.min(valid.length - 1, i + 1 + Math.floor(rnd() * 5)); after.set(at, [...(after.get(at) ?? []), row]); }
for (const [i, row] of valid.entries()) { rows.push(row); for (const x of after.get(i) ?? []) rows.push(x); }

// Sanity: active kept rows never overlap each other; each LEGACY_OVERLAP row overlaps an earlier kept active row.
const kept = rows.filter(r => !r.truth.problem);
const byRoom = new Map();
for (const r of kept.filter(r => !r.truth.cancelled)) { const list = byRoom.get(r.truth.code) ?? []; list.push(r); byRoom.set(r.truth.code, list); }
for (const list of byRoom.values()) {
  list.sort((a, b) => a.truth.startsAt - b.truth.startsAt);
  for (let i = 1; i < list.length; i++) if (list[i].truth.startsAt < list[i - 1].truth.endsAt) throw Error(`generator bug: ${list[i - 1].truth.legacyId} overlaps ${list[i].truth.legacyId}`);
}
for (const row of overlapRows) {
  const base = kept.find(k => k.truth.legacyId === row.truth.overlapsWith);
  const line = rows.indexOf(row), baseLine = rows.indexOf(base);
  if (!(baseLine < line)) throw Error('generator bug: overlap row before its base');
}

// ---- pre-existing bookings the hidden test creates before importing
const activeKept = kept.filter(r => !r.truth.cancelled);
const freeAround = (code, s, e) => !activeKept.some(r => r.truth.code === code && r.truth.startsAt < e && s < r.truth.endsAt);
const existing = [], conflictIds = [];
for (const r of activeKept.slice(3000)) {
  if (conflictIds.length >= 3) break;
  if (r.truth.endsAt - r.truth.startsAt < 3600_000 || conflictIds.some(id => kept.find(k => k.truth.legacyId === id).truth.code === r.truth.code)) continue;
  const s = new Date(r.truth.startsAt.getTime() + 15 * 60_000), e = new Date(s.getTime() + 30 * 60_000);
  existing.push({ room: r.truth.room, startsAt: s.toISOString(), endsAt: e.toISOString(), note: `overlaps ${r.truth.legacyId}` });
  conflictIds.push(r.truth.legacyId);
}
const huy = kept.find((r, i) => i > 5000 && r.truth.cancelled && freeAround(r.truth.code, r.truth.startsAt, r.truth.endsAt));
existing.push({ room: huy.truth.room, startsAt: huy.truth.startsAt.toISOString(), endsAt: huy.truth.endsAt.toISOString(), note: `same time as cancelled ${huy.truth.legacyId}` });
const b2b = activeKept.find((r, i) => i > 7000 && freeAround(r.truth.code, r.truth.endsAt, new Date(r.truth.endsAt.getTime() + 30 * 60_000)) && r.truth.endsAt.getUTCHours() < 10);
existing.push({ room: b2b.truth.room, startsAt: b2b.truth.endsAt.toISOString(), endsAt: new Date(b2b.truth.endsAt.getTime() + 30 * 60_000).toISOString(), note: `back-to-back after ${b2b.truth.legacyId}` });

// ---- write the CSV (UTF-8 BOM, CRLF, ';' separated, '"' quoting)
const quote = v => /[;"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
const header = ['ma_dat', 'ma_phong', 'ngay', 'gio_bd', 'gio_kt', 'tieu_de', 'nguoi_dat', 'trang_thai', 'ngay_huy'];
const csv = '﻿' + [header.join(';'), ...rows.map(r => r.fields.map(quote).join(';'))].join('\r\n') + '\r\n';
fs.mkdirSync(path.join(ROOT, 'project/data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'project/data/legacy-bookings.csv'), csv);

// ---- ground truth
const sample = r => ({ legacyId: r.truth.legacyId, room: r.truth.room, startsAt: r.truth.startsAt.toISOString(), endsAt: r.truth.endsAt.toISOString(),
  title: r.truth.title, organizer: r.truth.organizer, cancelled: r.truth.cancelled, cancelledAt: r.truth.cancelled ? r.truth.cancelledAt.toISOString() : null });
const problems = rows.map((r, i) => r.truth.problem && { line: i + 2, legacyId: r.truth.legacyId, reason: r.truth.problem }).filter(Boolean);
const expected = {
  total: rows.length,
  imported: kept.length,
  cancelledInFile: kept.filter(r => r.truth.cancelled).length,
  conflicts: conflictIds.length,
  skipped: problems.length,
  skippedByReason: problems.reduce((acc, p) => ({ ...acc, [p.reason]: (acc[p.reason] ?? 0) + 1 }), {}),
  problems,
  rooms: Object.fromEntries(CODES.map(c => [ROOMS[c][0], { capacity: ROOMS[c][1], bookings: kept.filter(r => r.truth.code === c).length }])),
  existing, conflictIds,
  notConflicts: [huy.truth.legacyId, b2b.truth.legacyId],
  samples: Object.fromEntries(Object.entries(marks).map(([quirk, id]) => [quirk, kept.find(r => r.truth.legacyId === id)]).filter(([, r]) => r).map(([q, r]) => [q, sample(r)])),
};
for (const id of [...conflictIds, huy.truth.legacyId, b2b.truth.legacyId]) expected.samples[`fixture row ${id}`] = sample(kept.find(r => r.truth.legacyId === id));
fs.mkdirSync(path.join(ROOT, 'hidden-p5/test'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'hidden-p5/test/legacy-expected.json'), JSON.stringify(expected, null, 1) + '\n');

// ---- the old import script
const { oldScript } = await import('./old-script.mjs');
fs.mkdirSync(path.join(ROOT, 'project/legacy'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'project/legacy/import-old.js'), oldScript({ ROOMS, ALIASES, rnd, pick }));
console.log(`rows ${rows.length}, kept ${kept.length}, problems ${problems.length} ${JSON.stringify(expected.skippedByReason)}, quirks ${Object.keys(expected.samples).length}`);
