-- catalog-service/db/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";


DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'video_status') THEN
        CREATE TYPE video_status AS ENUM (
            'processing',
            'pending_moderation',
            'available',
            'unavailable'
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


CREATE TABLE IF NOT EXISTS video (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id         UUID         NOT NULL UNIQUE,
    user_id           TEXT         NOT NULL,
    title             TEXT         NOT NULL,
    original_filename TEXT         NOT NULL,
    duration_seconds  INTEGER      NOT NULL CHECK (duration_seconds > 0),
    status            video_status NOT NULL DEFAULT 'processing',
    metadata          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    uploaded_at       TIMESTAMPTZ  NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_user_id    ON video (user_id);
CREATE INDEX IF NOT EXISTS idx_video_status     ON video (status);
CREATE INDEX IF NOT EXISTS idx_video_created_at ON video (created_at DESC);

DROP TRIGGER IF EXISTS video_set_updated_at ON video;
CREATE TRIGGER video_set_updated_at
    BEFORE UPDATE ON video
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS transcode_output (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    UUID        NOT NULL REFERENCES video (id) ON DELETE CASCADE,
    resolution  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (video_id, resolution)
);

CREATE INDEX IF NOT EXISTS idx_transcode_output_video_id ON transcode_output (video_id);


CREATE TABLE IF NOT EXISTS thumbnail (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    UUID        NOT NULL REFERENCES video (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thumbnail_video_id ON thumbnail (video_id);