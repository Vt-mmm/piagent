CREATE TABLE rooms (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  capacity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
