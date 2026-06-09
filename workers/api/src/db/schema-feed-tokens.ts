import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

/**
 * Per-user feed tokens — the opaque credential embedded in a user's personalized
 * Atom feed URL (`/v1/feed/relf_<lookupId>_<secret>.atom`).
 *
 * Worker-local schema island (sibling of schema-follows.ts), deliberately NOT in
 * the published core schema: user-coupled, the OSS CLI has no use for it. Queried
 * via explicit `.select().from(userFeedTokens)` on a `createDb(...)` handle.
 *
 * One row per user (`user_id` unique): mint and rotate are the same upsert
 * (replace the secret + lookupId), revoke deletes the row. The `secret` is stored
 * PLAINTEXT (reversible) — the feed serves only public release data with no PII,
 * so the full URL is re-revealable on every visit (see #1519 design, decision 6).
 * `user_id` cascades on account delete.
 *
 * Paired migration: 20260608010000_add_user_feed_tokens.sql.
 */
export const userFeedTokens = sqliteTable(
  "user_feed_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lookupId: text("lookup_id").notNull(),
    secret: text("secret").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("idx_user_feed_tokens_user").on(t.userId),
    uniqueIndex("idx_user_feed_tokens_lookup").on(t.lookupId),
  ],
);

export type UserFeedToken = typeof userFeedTokens.$inferSelect;
export type NewUserFeedToken = typeof userFeedTokens.$inferInsert;
