import { usageLog, type NewUsageLog } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";

/**
 * Minimal structural DB handle needed to write a `usage_log` row. Kept loose so
 * every caller (a worker `drizzle(env.DB)` handle, the wrapped `createDb`
 * handle, and the bun-sqlite test handle) satisfies it without importing
 * concrete drizzle types.
 */
export interface UsageLogDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): { values(row: unknown): Promise<unknown> };
}

/**
 * Persist a single `usage_log` row, fail-open: a write failure is logged but
 * never thrown, so usage accounting can never break ingest / enrichment / a
 * workflow step (Cloudflare would otherwise retry the whole step). All AI-call
 * instrumentation sites funnel through here so the insert shape lives in one
 * place.
 */
export async function logUsage(
  db: UsageLogDb,
  row: NewUsageLog,
  component = "usage-log",
): Promise<void> {
  try {
    await db.insert(usageLog).values(row);
  } catch (err) {
    logEvent("warn", {
      component,
      event: "usage-log-failed",
      err: err instanceof Error ? err : String(err),
    });
  }
}
