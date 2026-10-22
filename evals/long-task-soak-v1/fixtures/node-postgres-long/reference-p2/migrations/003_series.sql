-- Chuỗi đặt lịch định kỳ: các buổi của một chuỗi cùng series_id.
CREATE SEQUENCE booking_series_id_seq AS integer;
ALTER TABLE bookings ADD COLUMN series_id integer;
CREATE INDEX bookings_series_idx ON bookings (series_id) WHERE series_id IS NOT NULL;
