-- Editorial home-page promotion flag (#1270 follow-up). Additive, safe default.
ALTER TABLE organizations ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
