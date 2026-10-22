import { BookingError } from './errors.js';

const toRoom = row => row && ({ id: row.id, name: row.name, capacity: row.capacity, createdAt: row.created_at });

// Repository cho phòng họp và đặt lịch. Xem SPEC.md.
export function createRepository(pool) {
  return {
    async createRoom({ name, capacity }) {
      // TODO: kiểm tra dữ liệu và đổi lỗi Postgres thành BookingError (SPEC §2)
      const { rows } = await pool.query(
        'INSERT INTO rooms (name, capacity) VALUES ($1, $2) RETURNING *', [name, capacity]);
      return toRoom(rows[0]);
    },

    async getRoom(id) {
      const { rows } = await pool.query('SELECT * FROM rooms WHERE id = $1', [id]);
      return toRoom(rows[0]) ?? null;
    },

    // TODO: listRooms, updateRoom, deleteRoom (SPEC §2)
    // TODO: createBooking, getBooking, cancelBooking, listBookings (SPEC §3–§6)
  };
}

export { BookingError };
