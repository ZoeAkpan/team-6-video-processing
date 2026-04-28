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
    file_hash         TEXT         NOT NULL UNIQUE,
    user_id           TEXT         NOT NULL,
    title             TEXT         NOT NULL,
    original_filename TEXT         NOT NULL,
    duration_seconds  INTEGER      NOT NULL CHECK (duration_seconds > 0),
    status            video_status NOT NULL DEFAULT 'processing',
    uploaded_at       TIMESTAMPTZ  NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_user_id    ON video (user_id);
CREATE INDEX IF NOT EXISTS idx_video_status     ON video (status);
CREATE INDEX IF NOT EXISTS idx_video_created_at ON video (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_file_hash  ON video (file_hash);

ALTER TABLE video
    ADD COLUMN IF NOT EXISTS file_hash TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'video_file_hash_key'
    ) THEN
        ALTER TABLE video
            ADD CONSTRAINT video_file_hash_key UNIQUE (file_hash);
    END IF;
END $$;

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
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    file_hash         TEXT        NOT NULL REFERENCES video (file_hash) ON DELETE CASCADE,
    thumbnail_url     TEXT        NOT NULL,
    timestamp_seconds INTEGER     NOT NULL DEFAULT 0 CHECK (timestamp_seconds >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (file_hash, timestamp_seconds)
);

ALTER TABLE thumbnail
    ADD COLUMN IF NOT EXISTS file_hash TEXT,
    ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
    ADD COLUMN IF NOT EXISTS timestamp_seconds INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'thumbnail'
          AND column_name = 'video_id'
    ) THEN
        ALTER TABLE thumbnail
            ALTER COLUMN video_id DROP NOT NULL;

        EXECUTE '
            UPDATE thumbnail
            SET file_hash = video.file_hash
            FROM video
            WHERE thumbnail.video_id = video.id
              AND thumbnail.file_hash IS NULL
        ';
    END IF;
END $$;

UPDATE thumbnail
SET thumbnail_url = '/thumbnails/' || file_hash || '/0.jpg'
WHERE thumbnail_url IS NULL;

ALTER TABLE thumbnail
    ALTER COLUMN thumbnail_url SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'thumbnail_file_hash_fkey'
    ) THEN
        ALTER TABLE thumbnail
            ADD CONSTRAINT thumbnail_file_hash_fkey
            FOREIGN KEY (file_hash)
            REFERENCES video (file_hash)
            ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'thumbnail_timestamp_seconds_nonnegative'
    ) THEN
        ALTER TABLE thumbnail
            ADD CONSTRAINT thumbnail_timestamp_seconds_nonnegative
            CHECK (timestamp_seconds >= 0) NOT VALID;
    END IF;
END $$;

ALTER TABLE thumbnail
    VALIDATE CONSTRAINT thumbnail_timestamp_seconds_nonnegative;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'thumbnail_file_hash_timestamp_seconds_key'
    ) THEN
        ALTER TABLE thumbnail
            ADD CONSTRAINT thumbnail_file_hash_timestamp_seconds_key
            UNIQUE (file_hash, timestamp_seconds);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_thumbnail_file_hash ON thumbnail (file_hash);
