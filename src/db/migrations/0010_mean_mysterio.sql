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
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `category` text;--> statement-breakpoint
ALTER TABLE `products` ADD `category` text;