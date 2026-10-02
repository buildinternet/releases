-- Push-publish locators (#2376). A releases.json entry with `publish: "push"`
-- names a github repo plus the changelog file or glob the owner publishes
-- from. These columns mirror that payload so a stub's release_locations rows
-- still reconstruct the locator at promotion time. Null on every fetched
-- (feed/url/appstore/file/plain github) locator. The existing
-- release_locations_has_locator CHECK still applies — a push entry always
-- carries `github`, which is already one of the required locator columns.
ALTER TABLE release_locations ADD COLUMN publish TEXT CHECK (publish IS NULL OR publish = 'push');
ALTER TABLE release_locations ADD COLUMN path TEXT;
