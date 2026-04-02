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
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`org_id` text NOT NULL,
	`url` text,
	`description` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_products_org` ON `products` (`org_id`);--> statement-breakpoint
ALTER TABLE `releases` ADD `media` text DEFAULT '[]';--> statement-breakpoint
CREATE INDEX `idx_releases_source_suppressed_published` ON `releases` (`source_id`,`suppressed`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_releases_fetched_at` ON `releases` (`fetched_at`);--> statement-breakpoint
ALTER TABLE `sources` ADD `product_id` text REFERENCES products(id);--> statement-breakpoint
ALTER TABLE `sources` ADD `is_hidden` integer DEFAULT false;--> statement-breakpoint
CREATE INDEX `idx_sources_org_hidden` ON `sources` (`org_id`,`is_hidden`);--> statement-breakpoint
CREATE INDEX `idx_sources_product` ON `sources` (`product_id`);