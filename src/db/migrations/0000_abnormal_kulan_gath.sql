CREATE TABLE `org_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`platform` text NOT NULL,
	`handle` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_org_accounts_platform_handle` ON `org_accounts` (`platform`,`handle`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`domain` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_domain_unique` ON `organizations` (`domain`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`version` text,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`content_summary` text,
	`url` text,
	`content_hash` text,
	`metadata` text DEFAULT '{}',
	`published_at` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_releases_source_url` ON `releases` (`source_id`,`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_releases_source_hash` ON `releases` (`source_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_releases_source_published` ON `releases` (`source_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_releases_published` ON `releases` (`published_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`org_id` text,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`last_fetched_at` text,
	`last_content_hash` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_slug_unique` ON `sources` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_sources_org` ON `sources` (`org_id`);--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`source_slug` text,
	`release_count` integer,
	`created_at` text NOT NULL
);
