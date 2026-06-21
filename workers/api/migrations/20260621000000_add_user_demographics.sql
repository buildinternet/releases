-- Optional, opt-in demographic fields for aggregate insights (e.g. generational
-- response breakdowns). Paired with workers/api/src/db/schema-demographics.ts.
CREATE TABLE IF NOT EXISTS user_demographics (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  opted_in                  INTEGER NOT NULL DEFAULT 0,
  birth_year                INTEGER,
  birth_date                TEXT,
  gender                    TEXT,
  gender_custom             TEXT,
  sexual_orientation        TEXT,
  sexual_orientation_custom TEXT,
  country_code              TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_demographics_user
  ON user_demographics (user_id);