CREATE TABLE IF NOT EXISTS quotas (
    user_id TEXT PRIMARY KEY,
    upload_count INTEGER NOT NULL DEFAULT 0 CHECK (upload_count >= 0),
    upload_limit_count INTEGER NOT NULL DEFAULT 10 CHECK (upload_limit_count >= 0),
    storage_used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
    storage_limit_bytes BIGINT NOT NULL DEFAULT 1073741824 CHECK (storage_limit_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quota_consumptions (
    user_id TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    released_at TIMESTAMPTZ NULL,
    released_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, file_hash)
);

ALTER TABLE quota_consumptions
    ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

ALTER TABLE quota_consumptions
    ADD COLUMN IF NOT EXISTS released_reason TEXT;

ALTER TABLE quota_consumptions
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quotas_set_updated_at ON quotas;
CREATE TRIGGER quotas_set_updated_at
BEFORE UPDATE ON quotas
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS quota_consumptions_set_updated_at ON quota_consumptions;
CREATE TRIGGER quota_consumptions_set_updated_at
BEFORE UPDATE ON quota_consumptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

INSERT INTO quotas (
    user_id,
    upload_count,
    upload_limit_count,
    storage_used_bytes,
    storage_limit_bytes
)
VALUES (
    'user-123',
    0,
    10,
    0,
    1073741824
)
ON CONFLICT (user_id) DO NOTHING;