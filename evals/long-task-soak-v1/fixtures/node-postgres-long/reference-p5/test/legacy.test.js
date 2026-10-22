import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepository, importLegacy } from '../src/index.js';
import { setupPool, skip } from './helpers.js';

let pool, repo, dir;
before(async () => { if (skip) return; pool = await setupPool(); repo = createRepository(pool); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-')); });
after(async () => { await pool?.end(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('importLegacy: quirks of the old system, dryRun, re-run, conflicts', { skip }, async () => {
  const id = `T${process.pid}${Date.now() % 100000}`;
  const day = 1 + Math.floor(Math.random() * 27), month = 1 + Math.floor(Math.random() * 12), year = 2041 + Math.floor(Math.random() * 8);
  const d = `${day}/${month}/${year}`;
  const csv = '﻿' + [
    'ma_dat;ma_phong;ngay;gio_bd;gio_kt;tieu_de;nguoi_dat;trang_thai;ngay_huy',
    `${id}-1; p.101 ;${d};9h;10:00;"Họp R&amp;D";An.Nguyen@congty.vn;OK;`,
    `${id}-2;HT-A;${d};19:00;24:00;"Tối; sự kiện";;XAC_NHAN;`,
    `${id}-3;P101;${d};9:30;10:30;Trùng;binh;OK;`,
    `${id}-4;P999;${d};9:00;10:00;Kho;binh;OK;`,
    `${id}-5;PN1;31/02/2041;9:00;10:00;Sai ngày;binh;OK;`,
    `${id}-6;P101;${d};09:00;10:00;Đã huỷ;binh;HUY;`,
    `${id}-7;PHN2;${d};14:00;15:00;Trùng lịch mới;binh;;`,
  ].join('\r\n') + '\r\n';
  const file = path.join(dir, 'mini.csv');
  fs.writeFileSync(file, csv);
  const rooms = await repo.listRooms();
  let pn2 = rooms.find(r => r.name === 'Phòng Họp Nhỏ 2') ?? await repo.createRoom({ name: 'Phòng Họp Nhỏ 2', capacity: 3 });
  const [y, mo, dd] = [year, month, day];
  const existing = await repo.createBooking({ roomId: pn2.id, title: 'Lịch mới', organizer: 'moi', startsAt: new Date(Date.UTC(y, mo - 1, dd, 7, 30)), endsAt: new Date(Date.UTC(y, mo - 1, dd, 7, 45)) });

  const dry = await importLegacy(pool, { file, dryRun: true });
  assert.deepEqual({ ...dry, problems: dry.problems.map(p => [p.line, p.reason]) },
    { total: 7, imported: 4, alreadyImported: 0, conflicts: 1, skipped: 3, problems: [[4, 'LEGACY_OVERLAP'], [5, 'UNKNOWN_ROOM'], [6, 'INVALID_TIME']] });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings WHERE legacy_id LIKE $1', [`${id}-%`])).rows[0].n, 0);
  const real = await importLegacy(pool, { file });
  assert.equal(real.imported, 4);
  const get = n => pool.query('SELECT * FROM bookings WHERE legacy_id = $1', [`${id}-${n}`]).then(r => r.rows[0]);
  const one = await get(1);
  assert.equal(one.title, 'Họp R&D');
  assert.equal(one.organizer, 'an.nguyen');
  assert.equal(one.starts_at.toISOString(), new Date(Date.UTC(y, mo - 1, dd, 2)).toISOString());
  assert.equal((await get(2)).ends_at.toISOString(), new Date(Date.UTC(y, mo - 1, dd + 1, -7)).toISOString());
  assert.equal((await get(2)).organizer, 'khong-ro');
  assert.ok((await get(6)).cancelled_at);
  assert.equal((await get(7)).cancelled_reason, 'legacy-conflict');
  assert.equal((await repo.getBooking(existing.id)).cancelledAt ?? null, null);
  const again = await importLegacy(pool, { file });
  assert.equal(again.imported, 0);
  assert.equal(again.alreadyImported, 4);
});
