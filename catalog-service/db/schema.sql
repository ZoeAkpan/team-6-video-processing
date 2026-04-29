CREATE TABLE IF NOT EXISTS video (
    file_hash         TEXT         PRIMARY KEY,
    original_filename TEXT         NOT NULL,
    content_type      TEXT         NOT NULL,
    file_size_bytes   BIGINT       NOT NULL,
    uploaded_by       TEXT         NOT NULL,
    duration          INTEGER      NOT NULL CHECK (duration > 0),
    moderation_status TEXT         NOT NULL DEFAULT 'unmoderated',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS thumbnail (
    file_hash         TEXT         NOT NULL REFERENCES video(file_hash) ON DELETE CASCADE,
    thumbnail_url     TEXT         NOT NULL,
    timestamp_seconds INTEGER      NOT NULL DEFAULT 0 CHECK (timestamp_seconds >= 0),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (file_hash, timestamp_seconds)
);

CREATE INDEX IF NOT EXISTS idx_thumbnail_file_hash ON thumbnail(file_hash);