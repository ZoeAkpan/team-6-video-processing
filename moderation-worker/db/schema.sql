CREATE TABLE IF NOT EXISTS moderation_results (
  id BIGSERIAL PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  reason TEXT,
  source_event JSONB,
  moderated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moderation_poison_pills (
  id BIGSERIAL PRIMARY KEY,
  raw_payload TEXT NOT NULL,
  error_message TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);