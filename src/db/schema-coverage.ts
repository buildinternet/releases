import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { releases } from "@buildinternet/releases-core/schema";

export const releaseCoverage = sqliteTable(
  "release_coverage",
  {
    coverageId: text("coverage_id")
      .primaryKey()
      .references(() => releases.id, { onDelete: "cascade" }),
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    reason: text("reason"),
    decidedBy: text("decided_by").notNull(),
    decidedAt: text("decided_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_release_coverage_canonical").on(table.canonicalId)],
);

export type ReleaseCoverage = typeof releaseCoverage.$inferSelect;
export type NewReleaseCoverage = typeof releaseCoverage.$inferInsert;

/** Tags for the release_coverage.decided_by audit column. */
export const DECIDED_BY_CLI = "human:cli";
export const DECIDED_BY_CHANGESETS = "system:changesets";
export function decidedByAgent(model: string): string {
  return `agent:${model}`;
}
