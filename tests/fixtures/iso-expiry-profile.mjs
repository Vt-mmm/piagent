// Development-only implementations for the explicitly declared application
// profile. Neither imports family expectations nor supplies an execution oracle.
export const calendarExpirySource = String.raw`
function parseIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match || match[0] !== text) throw new TypeError("timestamp syntax");
  const [, y, m, d, h, min, sec = "0", fraction = "", zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) throw new TypeError("calendar range");
  const ms = Number((fraction + "000").slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(Number(h), Number(min), Number(sec), ms);
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4));
    if (hours > 23 || minutes > 59) throw new TypeError("offset range");
    offset = (zone[0] === "+" ? 1 : -1) * (hours * 60 + minutes);
  }
  return date.getTime() - offset * 60000;
}
function expiry(value) {
  if (typeof value === "string") return parseIso(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  throw new TypeError("expiry type");
}
function current(value) {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) throw new TypeError("now type");
  return timestamp;
}
export function run(expiresAt, now) {
  const deadline = expiry(expiresAt);
  const instant = arguments.length < 2 ? Date.now() : current(now);
  return instant >= deadline;
}
`;

export const ordinalExpirySource = String.raw`
const isLeap = y => y % 400 === 0 || y % 4 === 0 && y % 100 !== 0;
function parseIso(text) {
  const syntax = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.exec(text);
  if (syntax === null || syntax[0].length !== text.length) throw new TypeError();
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const utc = text.endsWith("Z"), zone = utc ? "Z" : text.slice(-6);
  const [h, m, rest = "0"] = text.slice(11, utc ? -1 : -6).split(":");
  const [seconds, digits = ""] = rest.split(".");
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]
    || +h > 23 || +m > 59 || +seconds > 59) throw new TypeError();
  let days = day - 1 - 719528;
  for (let y = 0; y < year; y++) days += isLeap(y) ? 366 : 365;
  for (let i = 0; i < month - 1; i++) days += lengths[i];
  let offset = 0;
  if (!utc) {
    const hh = +zone.slice(1, 3), mm = +zone.slice(4);
    if (hh > 23 || mm > 59) throw new TypeError();
    offset = (zone.startsWith("+") ? 1 : -1) * (hh * 60 + mm);
  }
  return (((days * 24 + +h) * 60 + +m - offset) * 60 + +seconds) * 1000 + +(digits + "000").slice(0, 3);
}
export function run(expiresAt, now) {
  const deadline = typeof expiresAt === "string" ? parseIso(expiresAt)
    : expiresAt instanceof Date ? expiresAt.valueOf() : NaN;
  if (!Number.isFinite(deadline)) throw new TypeError();
  const instant = arguments.length === 1 ? Date.now() : now instanceof Date ? +now : now;
  if (typeof instant !== "number" || !Number.isFinite(instant)) throw new TypeError();
  return deadline <= instant;
}
`;
