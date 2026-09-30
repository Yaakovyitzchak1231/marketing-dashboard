-- Collection runs health surface
CREATE TABLE collection_runs (
    id bigserial PRIMARY KEY,
    ran_at timestamptz UNIQUE NOT NULL,
    ok boolean,
    api_calls int,
    campaigns_collected int,
    campaigns_persisted int,
    stages jsonb,
    errors jsonb
);
CREATE INDEX idx_collection_runs_ran_at ON collection_runs(ran_at DESC);