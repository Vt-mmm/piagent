-- Token API: chỉ lưu sha256 của token.
CREATE TABLE api_tokens (
  token_sha256 text PRIMARY KEY,
  username text NOT NULL CHECK (btrim(username) <> ''),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
