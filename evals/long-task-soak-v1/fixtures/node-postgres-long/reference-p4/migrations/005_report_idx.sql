-- Báo cáo công suất: chỉ đặt lịch chưa huỷ, lọc theo starts_at.
CREATE INDEX bookings_report_idx ON bookings (starts_at) INCLUDE (room_id, ends_at) WHERE cancelled_at IS NULL;
