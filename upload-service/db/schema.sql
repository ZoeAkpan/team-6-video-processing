CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'upload_status') THEN
        CREATE TYPE upload_status AS ENUM (
            'pending',
            'processing',
            'completed',
            'failed'
        );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS upload (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_filename TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    file_hash TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
    uploaded_by TEXT NOT NULL,
    status upload_status NOT NULL DEFAULT 'pending',
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    processing_completed_at TIMESTAMPTZ,
    CHECK (
        processing_completed_at IS NULL
        OR processing_started_at IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_uploads_status ON upload (status);
CREATE INDEX IF NOT EXISTS idx_uploads_created_at ON upload (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_uploaded_by ON upload (uploaded_by);

ALTER TABLE upload
    ADD COLUMN IF NOT EXISTS file_hash TEXT;

DROP TRIGGER IF EXISTS uploads_set_updated_at ON upload;
CREATE TRIGGER uploads_set_updated_at
BEFORE UPDATE ON upload
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();