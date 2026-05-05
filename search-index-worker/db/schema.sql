CREATE TABLE IF NOT EXISTS video_search_index (
    file_hash TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    content_type VARCHAR(100),
    file_size_bytes BIGINT,
    uploaded_by TEXT,
    status VARCHAR(20),
    duration NUMERIC(10, 2),
    views INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    indexed_at TIMESTAMPTZ DEFAULT NOW()
);