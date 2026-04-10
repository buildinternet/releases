ALTER TABLE `fetch_log` ADD COLUMN `session_id` text;--> statement-breakpoint
CREATE INDEX `idx_fetch_log_session` ON `fetch_log` (`session_id`);
