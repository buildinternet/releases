CREATE TABLE `knowledge_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`org_id` text,
	`product_id` text,
	`content` text NOT NULL,
	`notes` text,
	`release_count` integer DEFAULT 0 NOT NULL,
	`last_contributing_release_at` text,
	`generated_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_pages_scope_org` ON `knowledge_pages` (`scope`,`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_pages_scope_product` ON `knowledge_pages` (`scope`,`product_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_pages_scope` ON `knowledge_pages` (`scope`);
