import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { newCronRunId } from "@releases/core-internal/id";

/**
 * Records one row per scheduled-event execution. Generic over `cronName` so
 * future crons (retier, poll-fetch) can be retrofitted into the same table
 * without a new migration. See docs/superpowers/specs/2026-04-18-scrape-agent-cron-design.md.
 */
export const cronRuns = sqliteTable(
  "cron_runs",
  {
    id: text("id").primaryKey().$defaultFn(newCronRunId),
    cronName: text("cron_name").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    durationMs: integer("duration_ms"),
    status: text("status", { enum: ["running", "done", "degraded", "dispatch_failed", "aborted"] }).notNull(),
    candidates: integer("candidates").notNull().default(0),
    dispatched: integer("dispatched").notNull().default(0),
    skippedOverCap: integer("skipped_over_cap").notNull().default(0),
    dispatchErrors: integer("dispatch_errors").notNull().default(0),
    sessionsStarted: text("sessions_started"),
    dispatchErrorDetail: text("dispatch_error_detail"),
    abortReason: text("abort_reason"),
    notes: text("notes"),
  },
  (table) => [
    index("idx_cron_runs_name_started").on(table.cronName, table.startedAt),
  ],
);

export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;
