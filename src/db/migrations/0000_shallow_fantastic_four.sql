CREATE TABLE `blocked_urls` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`type` text DEFAULT 'exact' NOT NULL,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocked_urls_pattern_unique` ON `blocked_urls` (`pattern`);--> statement-breakpoint
CREATE TABLE `fetch_log` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`releases_found` integer NOT NULL,
	`releases_inserted` integer NOT NULL,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`raw_content` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fetch_log_source` ON `fetch_log` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_fetch_log_created` ON `fetch_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `ignored_urls` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`org_id` text NOT NULL,
	`reason` text,
	`ignored_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ignored_urls_org_url` ON `ignored_urls` (`org_id`,`url`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`source_url` text NOT NULL,
	`source_filename` text,
	`content_type` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`source_id` text,
	`release_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_r2_key_unique` ON `media_assets` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_content_hash_unique` ON `media_assets` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_source` ON `media_assets` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_release` ON `media_assets` (`release_id`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_hash` ON `media_assets` (`content_hash`);--> statement-breakpoint
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
CREATE TABLE `org_tags` (
	`org_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_org_tags_pk` ON `org_tags` (`org_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_org_tags_tag` ON `org_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`domain` text,
	`description` text,
	`category` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_domain_unique` ON `organizations` (`domain`);--> statement-breakpoint
CREATE TABLE `product_tags` (
	`product_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_tags_pk` ON `product_tags` (`product_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_product_tags_tag` ON `product_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`org_id` text NOT NULL,
	`url` text,
	`description` text,
	`category` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_products_org` ON `products` (`org_id`);--> statement-breakpoint
CREATE TABLE `release_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`org_id` text,
	`type` text NOT NULL,
	`year` integer,
	`month` integer,
	`window_days` integer,
	`summary` text NOT NULL,
	`release_count` integer NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_summaries_unique` ON `release_summaries` (`source_id`,`org_id`,`type`,`year`,`month`);--> statement-breakpoint
CREATE INDEX `idx_summaries_source_type` ON `release_summaries` (`source_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_summaries_org_type` ON `release_summaries` (`org_id`,`type`);--> statement-breakpoint
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
	`media` text DEFAULT '[]',
	`published_at` text,
	`suppressed` integer DEFAULT false,
	`suppressed_reason` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_releases_source_url` ON `releases` (`source_id`,`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_releases_source_hash` ON `releases` (`source_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_releases_source_published` ON `releases` (`source_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_releases_published` ON `releases` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_releases_source_suppressed_published` ON `releases` (`source_id`,`suppressed`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_releases_fetched_at` ON `releases` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`org_id` text,
	`product_id` text,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`last_fetched_at` text,
	`last_content_hash` text,
	`fetch_priority` text DEFAULT 'normal',
	`consecutive_no_change` integer DEFAULT 0,
	`consecutive_errors` integer DEFAULT 0,
	`next_fetch_after` text,
	`is_primary` integer DEFAULT false,
	`is_hidden` integer DEFAULT false,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_slug_unique` ON `sources` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_sources_org` ON `sources` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_sources_org_hidden` ON `sources` (`org_id`,`is_hidden`);--> statement-breakpoint
CREATE INDEX `idx_sources_product` ON `sources` (`product_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
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
