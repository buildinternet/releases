import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * One row per workflow instance that exhausted retries. The summary workflow
 * (kicked once per fan-out) reads these rows for a given `scheduledTime` and
 * emits a single aggregated alert email.
 *
 * `id` is deterministic (`wf-fail-${scheduledTime}-${sourceId}`) so an
 * `INSERT OR REPLACE` on retry of the same instance is idempotent.
 */
export const workflowFailures = sqliteTable(
  "workflow_failures",
  {
    id: text("id").primaryKey(),
    scheduledTime: integer("scheduled_time").notNull(),
    sourceId: text("source_id").notNull(),
    stepName: text("step_name").notNull(),
    error: text("error").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_workflow_failures_scheduled").on(table.scheduledTime)],
);

export type WorkflowFailure = typeof workflowFailures.$inferSelect;
export type NewWorkflowFailure = typeof workflowFailures.$inferInsert;
