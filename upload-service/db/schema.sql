CREATE TABLE IF NOT EXISTS upload (
    file_hash TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    uploaded_by TEXT NOT NULL,
    duration NUMERIC NOT NULL CHECK (duration > 0),
    status TEXT NOT NULL DEFAULT 'pending_quota',
    quota_consumed BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT NULL,
    transcode_enqueued_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending_quota';

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS quota_consumed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS transcode_enqueued_at TIMESTAMPTZ;

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION set_upload_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS upload_set_updated_at ON upload;

CREATE TRIGGER upload_set_updated_at
BEFORE UPDATE ON upload
FOR EACH ROW
EXECUTE FUNCTION set_upload_updated_at();

CREATE INDEX IF NOT EXISTS idx_upload_status ON upload(status);