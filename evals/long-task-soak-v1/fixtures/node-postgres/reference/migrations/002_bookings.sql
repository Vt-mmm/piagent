CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE rooms DROP CONSTRAINT rooms_name_key;
CREATE UNIQUE INDEX rooms_name_lower_key ON rooms (lower(name));
ALTER TABLE rooms ADD CONSTRAINT rooms_capacity_range CHECK (capacity BETWEEN 1 AND 500);

-- Huỷ là xoá mềm (cancelled_at); chỉ đặt lịch chưa huỷ tham gia chống trùng.
-- Khoảng [starts_at, ends_at) nên hai lịch liền kề không trùng.
CREATE TABLE bookings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id integer NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  title text NOT NULL,
  organizer text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CONSTRAINT bookings_valid_range CHECK (ends_at > starts_at),
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    room_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (cancelled_at IS NULL)
);
CREATE INDEX bookings_order_idx ON bookings (starts_at, id);
CREATE INDEX bookings_room_idx ON bookings (room_id, starts_at, id);
