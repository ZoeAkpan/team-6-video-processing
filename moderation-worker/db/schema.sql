CREATE TABLE IF NOT EXISTS moderation_results (
  file_hash   TEXT        PRIMARY KEY,
  status      TEXT        NOT NULL,
  reason      TEXT        NOT NULL
);