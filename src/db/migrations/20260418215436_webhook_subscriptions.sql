CREATE TABLE `webhook_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`source_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`description` text,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`last_success_at` text,
	`last_error_at` text,
	`last_error_msg` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`disabled_reason` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_subs_org_enabled` ON `webhook_subscriptions` (`org_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_webhook_subs_org_source` ON `webhook_subscriptions` (`org_id`,`source_id`);