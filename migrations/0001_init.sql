CREATE TABLE accounts (
  greens_id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL,
  device_id TEXT NOT NULL,
  link_id TEXT NOT NULL UNIQUE,
  refresh_token TEXT NOT NULL,
  access_token TEXT NOT NULL,
  -- Unix time in milliseconds; NULL when the token does not state an expiry.
  access_expires_at INTEGER,
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX accounts_mobile ON accounts (mobile);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  greens_id INTEGER NOT NULL REFERENCES accounts (greens_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
