import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

/**
 * Per-user digest email preferences — cadence + the published-date watermark + the
 * opaque `reld_` manage token for the no-login unsubscribe lane.
 *
 * Worker-local schema island (sibling of schema-follows.ts / schema-feed-tokens.ts),
 * deliberately NOT in the published `@buildinternet/releases-core` schema: user-coupled
 * data the OSS CLI has no business with. Queried via explicit `.select().from(userDigestPrefs)`
 * on a `createDb(...)` handle.
 *
 * One row per user (`user_id` unique). The row is created lazily on the first
 * `PUT /v1/me/digest`; absence == cadence `off`. `last_digest_at` is the content
 * watermark only (the crons drive scheduling): stamped to `now` on an off→on
 * transition, advanced to the cron `runStart` after a successful send.
 * `manage_token` is a reversible opaque secret (it only toggles the user's own
 * digest off). `user_id` cascades on account delete.
 *
 * Paired migration: 20260609000000_add_user_digest_prefs.sql.
 */
export const DIGEST_CADENCES = ["off", "daily", "weekly"] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export const userDigestPrefs = sqliteTable(
  "user_digest_prefs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    cadence: text("cadence", { enum: DIGEST_CADENCES }).notNull().default("off"),
    lastDigestAt: integer("last_digest_at", { mode: "timestamp" }),
    manageToken: text("manage_token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_user_digest_prefs_user").on(t.userId),
    uniqueIndex("idx_user_digest_prefs_token").on(t.manageToken),
    index("idx_user_digest_prefs_cadence").on(t.cadence),
  ],
);

export type UserDigestPrefs = typeof userDigestPrefs.$inferSelect;
export type NewUserDigestPrefs = typeof userDigestPrefs.$inferInsert;
