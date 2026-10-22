# dat-phong-hop

Tầng dịch vụ đặt lịch phòng họp (Node 22, ESM, driver `pg`, PostgreSQL 17).
Đặc tả ở `SPEC.md`.

```bash
npm install
eval "$(bash scripts/db-up.sh)"   # khởi động Postgres trong Docker, đặt DATABASE_URL
npm run migrate
npm test                          # test tích hợp với Postgres thật
bash scripts/db-down.sh           # dừng container khi xong
```

Có thể dùng `docker-compose.yml` thay cho `scripts/db-up.sh`.
