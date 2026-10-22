// Importer dữ liệu hệ thống cũ (docs/backlog/05-chuyen-du-lieu-cu.md). Cách
// hiểu từng dòng theo legacy/import-old.js.
import fs from 'node:fs/promises';

const COLUMNS = ['ma_dat', 'ma_phong', 'ngay', 'gio_bd', 'gio_kt', 'tieu_de', 'nguoi_dat', 'trang_thai', 'ngay_huy'];
const ROOMS = {
  P101: ['Phòng Sen', 8], P102: ['Phòng Mai', 6], P103: ['Phòng Đào', 6], P201: ['Phòng Cúc', 10], P202: ['Phòng Lan', 12],
  P203: ['Phòng Trúc', 4], P301: ['Phòng Đào Tạo', 40], P302: ['Phòng Giám Đốc', 8], HTA: ['Hội trường A', 300], HTB: ['Hội trường B', 150],
  PN1: ['Phòng Họp Nhỏ 1', 3], PN2: ['Phòng Họp Nhỏ 2', 3],
};
const ALIASES = { 'HOI TRUONG A': 'HTA', 'HOI TRUONG B': 'HTB', 'PHONG SEN': 'P101', PHN1: 'PN1', PHN2: 'PN2', 'GIAM DOC': 'P302' };
const ACTIVE = new Set(['', 'OK', 'XAC_NHAN', 'DA_DUYET']), CANCELLED = new Set(['HUY', 'DA_HUY', 'CANCEL']);
const OFFSET_MS = 7 * 3600_000;

function splitLine(line) {
  const fields = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; }
    else if (c === '"') quoted = true;
    else if (c === ';') { fields.push(cur); cur = ''; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}
function roomCode(raw) {
  let code = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (ALIASES[code]) code = ALIASES[code];
  code = code.replace(/[.\- ]/g, '');
  return ROOMS[code] ? code : null;
}
function day(raw) {
  const s = String(raw ?? '').trim(); let m, y, mo, d;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else return null;
  const days = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]) return null;
  return [y, mo, d];
}
function minutes(raw, isEnd) {
  const m = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?|h(\d{2})?)$/.exec(String(raw ?? '').trim().toLowerCase());
  if (!m) return null;
  const h = +m[1], mi = +(m[2] ?? m[4] ?? 0), sec = +(m[3] ?? 0);
  if (sec !== 0 || mi > 59) return null;
  if (h === 24 && mi === 0 && isEnd) return 1440;
  if (h > 23) return null;
  return h * 60 + mi;
}
const at = (d, min) => new Date(Date.UTC(d[0], d[1] - 1, d[2], 0, min) - OFFSET_MS);
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// → { reason } or a parsed row
function parseRow(o) {
  const code = roomCode(o.ma_phong);
  if (!code) return { reason: 'UNKNOWN_ROOM' };
  const d = day(o.ngay);
  if (!d) return { reason: 'INVALID_TIME' };
  const s = minutes(o.gio_bd, false), e = minutes(o.gio_kt, true);
  if (s === null || e === null || e <= s) return { reason: 'INVALID_TIME' };
  const startsAt = at(d, s), endsAt = at(d, e);
  const status = String(o.trang_thai ?? '').trim().toUpperCase();
  const cancelled = CANCELLED.has(status);
  let cancelledAt = null;
  if (cancelled) {
    cancelledAt = startsAt;
    const parts = String(o.ngay_huy ?? '').trim().split(/\s+/);
    if (parts.length === 2) { const cd = day(parts[0]), cm = minutes(parts[1], false); if (cd && cm !== null) cancelledAt = at(cd, cm); }
  }
  let organizer = String(o.nguoi_dat ?? '').trim().toLowerCase();
  if (organizer.includes('@')) organizer = organizer.split('@')[0];
  const title = decode(String(o.tieu_de ?? '').trim()).trim();
  return { legacyId: String(o.ma_dat ?? '').trim(), code, room: ROOMS[code][0], startsAt, endsAt, cancelled, cancelledAt,
    title: title || '(không tiêu đề)', organizer: organizer || 'khong-ro' };
}

export async function readLegacyFile(file) {
  let text = await fs.readFile(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== COLUMNS.join(';')) throw new Error(`unexpected header in ${file}`);
  const rows = [], problems = []; let total = 0;
  const kept = new Map(); // room code → active kept rows
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    total++;
    const values = splitLine(lines[i]);
    const o = Object.fromEntries(COLUMNS.map((c, j) => [c, values[j] ?? '']));
    const row = parseRow(o), line = i + 1;
    if (row.reason) { problems.push({ line, legacyId: String(o.ma_dat).trim(), reason: row.reason }); continue; }
    if (!row.cancelled) {
      const list = kept.get(row.code) ?? [];
      if (list.some(k => k.startsAt < row.endsAt && row.startsAt < k.endsAt)) { problems.push({ line, legacyId: row.legacyId, reason: 'LEGACY_OVERLAP' }); continue; }
      list.push(row); kept.set(row.code, list);
    }
    rows.push(row);
  }
  return { total, rows, problems };
}

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function importLegacy(pool, { file, dryRun = false } = {}) {
  const { total, rows, problems } = await readLegacyFile(file);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // No other booking may slip in between the conflict check and the insert.
    await client.query('LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE');
    const names = [...new Set(rows.map(r => r.room))];
    // Matched in JS: the database's lower() may not fold Vietnamese capitals (C locale).
    const wanted = new Set(names.map(n => n.toLowerCase()));
    const roomIds = new Map((await client.query('SELECT id, name FROM rooms')).rows.filter(r => wanted.has(r.name.toLowerCase())).map(r => [r.name.toLowerCase(), r.id]));
    const already = new Set((await client.query('SELECT legacy_id FROM bookings WHERE legacy_id = ANY($1)', [rows.map(r => r.legacyId)])).rows.map(r => r.legacy_id));
    const todo = rows.filter(r => !already.has(r.legacyId));
    // Decision: an active legacy row overlapping an existing booking is imported cancelled with reason 'legacy-conflict'.
    const conflicting = new Set();
    const checkable = todo.filter(r => !r.cancelled && roomIds.has(r.room.toLowerCase()));
    for (const part of chunks(checkable, 2000)) {
      const { rows: hits } = await client.query(
        `SELECT DISTINCT c.k FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[]) WITH ORDINALITY AS c(room_id, s, e, k)
           JOIN bookings b ON b.room_id = c.room_id AND b.cancelled_at IS NULL AND b.starts_at < c.e AND b.ends_at > c.s`,
        [part.map(r => roomIds.get(r.room.toLowerCase())), part.map(r => r.startsAt), part.map(r => r.endsAt)]);
      for (const h of hits) conflicting.add(part[Number(h.k) - 1]);
    }
    if (!dryRun) {
      for (const name of names) {
        if (roomIds.has(name.toLowerCase())) continue;
        const capacity = Object.values(ROOMS).find(([n]) => n === name)[1];
        roomIds.set(name.toLowerCase(), (await client.query('INSERT INTO rooms (name, capacity) VALUES ($1, $2) RETURNING id', [name, capacity])).rows[0].id);
      }
      for (const part of chunks(todo, 1000)) {
        await client.query(
          `INSERT INTO bookings (room_id, title, organizer, starts_at, ends_at, cancelled_at, cancelled_reason, legacy_id)
           SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::timestamptz[], $7::text[], $8::text[])`,
          [part.map(r => roomIds.get(r.room.toLowerCase())), part.map(r => r.title), part.map(r => r.organizer), part.map(r => r.startsAt), part.map(r => r.endsAt),
            part.map(r => conflicting.has(r) ? new Date() : r.cancelledAt), part.map(r => conflicting.has(r) ? 'legacy-conflict' : r.cancelled ? 'legacy-cancelled' : null),
            part.map(r => r.legacyId)]);
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { total, imported: todo.length, alreadyImported: rows.length - todo.length, conflicts: conflicting.size, skipped: problems.length, problems };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
