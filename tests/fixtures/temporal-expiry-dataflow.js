function expiryTimestamp(value) {
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (match) {
      const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00", fraction = "", zone] = match;
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      const hour = Number(hourText);
      const minute = Number(minuteText);
      const second = Number(secondText);
      const daysInMonth = new Date(Date.UTC(2001, month, 0)).getUTCDate();
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const validDays = month === 2 && leap ? 29 : daysInMonth;
      if (month >= 1 && month <= 12 && day >= 1 && day <= validDays && hour <= 23 && minute <= 59 && second <= 59) {
        const milliseconds = Number((fraction.slice(1) + "000").slice(0, 3));
        const utcDate = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, milliseconds));
        utcDate.setUTCFullYear(year);
        const offset = zone === "Z" ? 0 : Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4));
        if (zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)) {
          return utcDate.getTime() - (zone.startsWith("+") ? offset : -offset) * 60000;
        }
      }
    }
  } else if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }

  throw new TypeError("expiresAt must be a valid ISO timestamp string or Date");
}

function currentTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();

  throw new TypeError("now must be a finite millisecond number or Date");
}

export function isExpired(expiresAt, now) {
  const current = arguments.length < 2 ? Date.now() : now;
  return currentTimestamp(current) >= expiryTimestamp(expiresAt);
}
