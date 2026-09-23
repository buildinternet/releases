import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";
import { webhookSubscriptions } from "@buildinternet/releases-core/schema";
import { user } from "./schema-auth.js";

/**
 * User-owned semantic alerts (#2304 Phase 1).
 *
 * Worker-local schema island (sibling of schema-follows.ts), deliberately NOT in
 * the published `@buildinternet/releases-core` schema: this is user-coupled data
 * the OSS CLI has no business with. Queried via explicit `.select().from(semanticAlerts)`
 * on a `createDb(...)` handle.
 *
 * The candidate pool is follows-only for every row (a product constant, not a
 * column): a release is eligible only if it already hits the owner's follow
 * graph. Phase 2 scores enabled rows with JEV and delivers email/webhook.
 *
 * `query` is user-private. Do not copy it into Analytics Engine points or logs.
 * `webhook_subscription_id` optionally points at one of the owner's
 * `/v1/me/webhooks` rows; deleting that subscription clears the pointer.
 * `user_id` cascades on account delete.
 *
 * Paired migration: 20260922020000_add_semantic_alerts.sql.
 */
export const semanticAlerts = sqliteTable(
  "semantic_alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    threshold: real("threshold").notNull().default(0.8),
    deliverEmail: integer("deliver_email", { mode: "boolean" }).notNull().default(true),
    deliverWebhook: integer("deliver_webhook", { mode: "boolean" }).notNull().default(false),
    webhookSubscriptionId: text("webhook_subscription_id").references(
      () => webhookSubscriptions.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_semantic_alerts_user").on(t.userId)],
);

export type SemanticAlertRow = typeof semanticAlerts.$inferSelect;
export type NewSemanticAlertRow = typeof semanticAlerts.$inferInsert;

/**
 * One recorded match per alert and release. The primary key is the idempotency
 * key: a second publish of the same pair does not send again. Query text is
 * not stored here.
 *
 * Paired migration: 20260922030000_semantic_alert_matches.sql.
 * `(alert_id, created_at)` backs the account activity read (30-day counts
 * and the latest match per alert). Paired migration:
 * 20260922200000_semantic_alert_matches_alert_created_idx.sql.
 */
export const semanticAlertMatches = sqliteTable(
  "semantic_alert_matches",
  {
    alertId: text("alert_id")
      .notNull()
      .references(() => semanticAlerts.id, { onDelete: "cascade" }),
    releaseId: text("release_id").notNull(),
    probability: real("probability").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.alertId, t.releaseId] }),
    index("idx_semantic_alert_matches_alert_created").on(t.alertId, t.createdAt),
  ],
);

export type SemanticAlertMatchRow = typeof semanticAlertMatches.$inferSelect;
