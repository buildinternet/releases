CREATE TABLE `release_coverage` (
	`coverage_id` text PRIMARY KEY NOT NULL,
	`canonical_id` text NOT NULL,
	`reason` text,
	`decided_by` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`coverage_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_release_coverage_canonical` ON `release_coverage` (`canonical_id`);