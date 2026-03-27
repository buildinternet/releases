ALTER TABLE `releases` ADD `suppressed` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `releases` ADD `suppressed_reason` text;