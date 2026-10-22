import { padLeft } from './text.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

/** YYYY-MM-DD with month 01-12 and day 01-31 (month length is not checked: legacy quirk). */
export function isDate(text) {
  const m = DATE_RE.exec(String(text));
  if (!m) return false;
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function dayNumber(text) {
  const m = DATE_RE.exec(text);
  return Math.floor(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / DAY_MS);
}

export function dateFromDayNumber(n) {
  const d = new Date(n * DAY_MS);
  return d.getUTCFullYear() + '-' + padLeft(d.getUTCMonth() + 1, 2, '0') + '-' + padLeft(d.getUTCDate(), 2, '0');
}

export const weekdayOf = n => new Date(n * DAY_MS).getUTCDay();

/** ISO week key, e.g. 2025-W07. */
export function isoWeek(text) {
  const n = dayNumber(text);
  const weekday = (weekdayOf(n) + 6) % 7; // Monday = 0
  const thursday = n - weekday + 3;
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const jan1 = Math.floor(Date.UTC(year, 0, 1) / DAY_MS);
  return year + '-W' + padLeft(Math.floor((thursday - jan1) / 7) + 1, 2, '0');
}
