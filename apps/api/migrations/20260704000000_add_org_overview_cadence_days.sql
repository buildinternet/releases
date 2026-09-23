-- Manual override for the automated overview-regen cadence (#1895). NULL =
-- automatic (velocity-tiered); a set value pins the org to a fixed cadence in
-- days. The organizations_active / organizations_public SELECT * views expose
-- the new column at query time — no view recreation required.
ALTER TABLE organizations ADD COLUMN overview_cadence_days INTEGER;
