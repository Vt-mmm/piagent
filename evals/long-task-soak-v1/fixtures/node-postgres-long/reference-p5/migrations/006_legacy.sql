-- Dữ liệu chuyển từ hệ thống cũ: legacy_id = ma_dat; cancelled_reason cho
-- lịch cũ trùng với lịch đã có ('legacy-conflict') và lịch cũ đã huỷ.
ALTER TABLE bookings ADD COLUMN legacy_id text UNIQUE;
ALTER TABLE bookings ADD COLUMN cancelled_reason text;
