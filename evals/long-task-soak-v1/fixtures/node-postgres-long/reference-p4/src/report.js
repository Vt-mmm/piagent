// Báo cáo công suất phòng theo tuần (docs/backlog/04-bao-cao.md).
import { BookingError } from './errors.js';

const fail = (code, message) => { throw new BookingError(code, message); };
const instant = (value, field) => {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) fail('INVALID_INPUT', `${field} must be a Date or ISO 8601 string`);
  return date;
};

export const REPORT_SQL = `
WITH weekly AS (
  SELECT b.room_id,
         date_trunc('week', b.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS week_start,
         count(*)::int AS bookings,
         round(sum(extract(epoch FROM b.ends_at - b.starts_at)) / 60)::int AS booked_minutes
    FROM bookings b
   WHERE b.cancelled_at IS NULL AND b.starts_at >= $1 AND b.starts_at < $2 AND ($3::int IS NULL OR b.room_id = $3)
   GROUP BY 1, 2
)
SELECT w.room_id, r.name AS room_name, w.week_start, w.bookings, w.booked_minutes,
       round(w.booked_minutes / 3000.0, 4)::float8 AS utilisation,
       rank() OVER (PARTITION BY w.week_start ORDER BY w.booked_minutes DESC)::int AS rank_in_week,
       (w.booked_minutes - lag(w.booked_minutes) OVER (PARTITION BY w.room_id ORDER BY w.week_start))::int AS change
  FROM weekly w JOIN rooms r ON r.id = w.room_id
 ORDER BY w.week_start, rank_in_week, r.name, w.room_id`;

export function reportMethods(pool) {
  return {
    async utilisationReport({ from, to, roomId } = {}) {
      const f = instant(from, 'from'), t = instant(to, 'to');
      if (!(f < t)) fail('INVALID_INPUT', 'from must be before to');
      if (t - f > 366 * 86_400_000) fail('INVALID_INPUT', 'at most 366 days');
      if (roomId !== undefined && roomId !== null && !Number.isInteger(roomId)) fail('INVALID_INPUT', 'roomId must be an integer');
      const { rows } = await pool.query(REPORT_SQL, [f, t, roomId ?? null]);
      return rows.map(r => ({
        roomId: r.room_id, roomName: r.room_name, weekStart: r.week_start, bookings: r.bookings, bookedMinutes: r.booked_minutes,
        utilisation: r.utilisation, rankInWeek: r.rank_in_week, changeFromPreviousWeek: r.change,
      }));
    },
  };
}
