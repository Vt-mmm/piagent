function readInstant(value) {
  const timestamp = Date.prototype.getTime.call(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Invalid timestamp");
  return timestamp;
}

function parseDeadline(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TypeError("Invalid timestamp");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const zone = match[8];
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const offsetMinutes = (zone[0] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) throw new TypeError("Invalid timestamp");
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) throw new TypeError("Invalid timestamp");
  return readInstant(new Date(date.getTime() - offsetMinutes * 60_000));
}

function deadlineValue(value) {
  if (typeof value === "string") return parseDeadline(value);
  if (value instanceof Date) return readInstant(value);
  throw new TypeError("Invalid timestamp");
}

function referenceValue(value) {
  if (value instanceof Date) return readInstant(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("Invalid timestamp");
}

export function deadlinePassed(deadline, currentTime) {
  const timestamp = deadlineValue(deadline);
  const reference = arguments.length === 1 ? Date.now() : referenceValue(currentTime);
  return reference >= timestamp;
}
