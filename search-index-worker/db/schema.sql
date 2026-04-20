CREATE TABLE IF NOT EXISTS search_index (
    video_id VARCHAR(255) PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    indexed_at TIMESTAMPTZ NOT NULL
);