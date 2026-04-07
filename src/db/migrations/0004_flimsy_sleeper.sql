CREATE TABLE `domain_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`org_id` text,
	`product_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_aliases_domain_unique` ON `domain_aliases` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_domain_aliases_org` ON `domain_aliases` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_domain_aliases_product` ON `domain_aliases` (`product_id`);