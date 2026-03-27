ALTER TABLE `sources` ADD `fetch_priority` text DEFAULT 'normal';--> statement-breakpoint
ALTER TABLE `sources` ADD `consecutive_no_change` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sources` ADD `consecutive_errors` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `sources` ADD `next_fetch_after` text;