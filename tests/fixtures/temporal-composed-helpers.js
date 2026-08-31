function rejectInvalid(value) {
  throw new TypeError("Invalid timestamp");
}

function parseTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return rejectInvalid(value);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return rejectInvalid(value);
  const milliseconds = fractionText === undefined ? 0 : Number(fractionText.slice(0, 3).padEnd(3, "0"));
  const anchor = Date.UTC(2000, month - 1, day, hour, minute, second, milliseconds);
  const date = new Date(anchor);
  date.setUTCFullYear(year);
  return date.getTime() - (zone === "Z" ? 0 : (zone[0] === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutes) * 60000);
}

function expiration(value) {
  if (typeof value === "string") return parseTimestamp(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return rejectInvalid(value);
}

function current(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return rejectInvalid(value);
}

export function isExpired(expiresAt, now) {
  const time = arguments.length === 1 ? Date.now() : current(now);
  return time >= expiration(expiresAt);
}
