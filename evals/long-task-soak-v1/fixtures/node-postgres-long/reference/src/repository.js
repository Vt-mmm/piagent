import { BookingError } from './errors.js';

const fail = (code, message) => { throw new BookingError(code, message); };

const toRoom = row => row && ({ id: row.id, name: row.name, capacity: row.capacity, createdAt: row.created_at });
const toBooking = row => row && ({
  id: row.id, roomId: row.room_id, title: row.title, organizer: row.organizer,
  startsAt: row.starts_at, endsAt: row.ends_at, createdAt: row.created_at, cancelledAt: row.cancelled_at,
});

const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${field} must be a non-empty string`);
  return value.trim();
};
const capacityOf = value => {
  if (!Number.isInteger(value) || value < 1 || value > 500) fail('INVALID_INPUT', 'capacity must be an integer from 1 to 500');
  return value;
};
const instant = (value, field) => {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) fail('INVALID_INPUT', `${field} must be a Date or ISO 8601 string`);
  return date;
};

const encodeCursor = row => Buffer.from(JSON.stringify([row.starts_at.toISOString(), row.id])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const [startsAt, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const date = new Date(startsAt);
    if (Number.isNaN(date.getTime()) || !Number.isInteger(id)) throw new Error('bad cursor');
    return { startsAt: date, id };
  } catch { return fail('INVALID_INPUT', 'invalid cursor'); }
}

// Postgres errors that are business outcomes.
function translate(error) {
  if (error instanceof BookingError) return error;
  if (error.code === '23505' && error.table === 'rooms') return new BookingError('ROOM_NAME_TAKEN', 'room name already exists');
  if (error.code === '23P01') return new BookingError('BOOKING_CONFLICT', 'the room is already booked for that time');
  if (error.code === '23503' && error.table === 'bookings') return new BookingError('NOT_FOUND', 'room not found');
  return error;
}
const guarded = fn => async (...args) => { try { return await fn(...args); } catch (error) { throw translate(error); } };

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createRepository(pool) {
  return {
    createRoom: guarded(async ({ name, capacity } = {}) => {
      const { rows } = await pool.query('INSERT INTO rooms (name, capacity) VALUES ($1, $2) RETURNING *', [text(name, 'name'), capacityOf(capacity)]);
      return toRoom(rows[0]);
    }),

    getRoom: guarded(async id => toRoom((await pool.query('SELECT * FROM rooms WHERE id = $1', [id])).rows[0]) ?? null),

    listRooms: guarded(async () => (await pool.query('SELECT * FROM rooms ORDER BY name, id')).rows.map(toRoom)),

    updateRoom: guarded(async (id, patch = {}) => {
      const sets = [], values = [id];
      if (patch.name !== undefined) { values.push(text(patch.name, 'name')); sets.push(`name = $${values.length}`); }
      if (patch.capacity !== undefined) { values.push(capacityOf(patch.capacity)); sets.push(`capacity = $${values.length}`); }
      const sql = sets.length ? `UPDATE rooms SET ${sets.join(', ')} WHERE id = $1 RETURNING *` : 'SELECT * FROM rooms WHERE id = $1';
      const { rows } = await pool.query(sql, values);
      return toRoom(rows[0]) ?? fail('NOT_FOUND', 'room not found');
    }),

    deleteRoom: guarded(id => inTransaction(pool, async client => {
      const room = (await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!room) fail('NOT_FOUND', 'room not found');
      const active = await client.query('SELECT 1 FROM bookings WHERE room_id = $1 AND cancelled_at IS NULL LIMIT 1', [id]);
      if (active.rowCount) fail('ROOM_IN_USE', 'room still has active bookings');
      await client.query('DELETE FROM rooms WHERE id = $1', [id]);
    })),

    // Bookings of one room serialize on the room row (FOR UPDATE), so
    // concurrent partially-overlapping inserts cannot deadlock on the GiST
    // exclusion constraint; the constraint itself guarantees no overlap and
    // turns any loser into 23P01 → BOOKING_CONFLICT.
    createBooking: guarded(async ({ roomId, title, organizer, startsAt, endsAt } = {}) => {
      const values = [roomId, text(title, 'title'), text(organizer, 'organizer'), instant(startsAt, 'startsAt'), instant(endsAt, 'endsAt')];
      if (values[4] <= values[3]) fail('INVALID_INPUT', 'endsAt must be after startsAt');
      if (!Number.isInteger(roomId)) fail('NOT_FOUND', 'room not found');
      return inTransaction(pool, async client => {
        const room = await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
        if (!room.rowCount) fail('NOT_FOUND', 'room not found');
        const { rows } = await client.query(
          `INSERT INTO bookings (room_id, title, organizer, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`, values);
        return toBooking(rows[0]);
      });
    }),

    getBooking: guarded(async id => toBooking((await pool.query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0]) ?? null),

    cancelBooking: guarded(id => inTransaction(pool, async client => {
      const row = (await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!row) fail('NOT_FOUND', 'booking not found');
      if (row.cancelled_at) fail('ALREADY_CANCELLED', 'booking already cancelled');
      const { rows } = await client.query('UPDATE bookings SET cancelled_at = now() WHERE id = $1 RETURNING *', [id]);
      return toBooking(rows[0]);
    })),

    listBookings: guarded(async ({ roomId, from, to, includeCancelled = false, limit = 20, cursor } = {}) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 'limit must be an integer from 1 to 100');
      const where = [], values = [];
      const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
      if (roomId !== undefined && roomId !== null) add('room_id = ?', roomId);
      if (from !== undefined && from !== null) add('ends_at > ?', instant(from, 'from'));
      if (to !== undefined && to !== null) add('starts_at < ?', instant(to, 'to'));
      if (!includeCancelled) where.push('cancelled_at IS NULL');
      if (cursor !== undefined && cursor !== null) {
        const after = decodeCursor(cursor);
        values.push(after.startsAt, after.id);
        where.push(`(starts_at, id) > ($${values.length - 1}, $${values.length})`);
      }
      values.push(limit + 1);
      const { rows } = await pool.query(
        `SELECT * FROM bookings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY starts_at, id LIMIT $${values.length}`, values);
      const page = rows.slice(0, limit);
      return { items: page.map(toBooking), nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null };
    }),
  };
}

export { BookingError };
