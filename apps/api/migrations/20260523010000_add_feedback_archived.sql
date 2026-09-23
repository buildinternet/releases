-- Soft-removal flag for feedback. Lets the triage write-path
-- (PATCH /v1/feedback/:id) archive spam/test/handled rows so they drop out of
-- the default admin read path without losing the row. Hard delete still exists
-- (DELETE /v1/feedback/:id) for genuine junk. Default keeps every existing row
-- visible (archived = 0).
ALTER TABLE feedback ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
