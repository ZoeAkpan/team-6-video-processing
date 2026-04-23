CREATE TABLE IF NOT EXISTS upload (
    file_hash         TEXT        PRIMARY KEY,
    original_filename TEXT        NOT NULL,
    content_type      TEXT        NOT NULL,
    file_size_bytes   BIGINT      NOT NULL CHECK (file_size_bytes >= 0),
    uploaded_by       TEXT        NOT NULL,
    duration          NUMERIC     NOT NULL
);