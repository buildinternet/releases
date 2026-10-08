import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { collections } from "@buildinternet/releases-core/schema";
import { user } from "./schema-auth.js";

/**
 * A user's opt-in to receive one collection's weekly digest by email (#2459).
 *
 * Worker-local schema island (sibling of schema-digest-prefs.ts), deliberately NOT
 * in the published `@buildinternet/releases-core` schema: user-coupled data the OSS
 * CLI has no business with. A subscription is not a follow — follows shape the
 * feed, this only sends mail.
 *
 * `last_sent_week` is the exactly-once guard: the ET-Monday `weekStart` of the last
 * digest mailed for this row. A send is claimed by moving it forward with a
 * conditional UPDATE before the email goes out, so a queue redelivery or a
 * workflow replay can't mail the same week twice. Unsubscribe uses the user's
 * `reld_` manage token (user_digest_prefs) and deletes only this row.
 *
 * Paired migration: 20261008180000_add_user_collection_digest_subs.sql.
 */
export const userCollectionDigestSubs = sqliteTable(
  "user_collection_digest_subs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    lastSentWeek: text("last_sent_week"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_user_collection_digest_subs_unique").on(t.userId, t.collectionId),
    index("idx_user_collection_digest_subs_collection").on(t.collectionId),
  ],
);

export type UserCollectionDigestSub = typeof userCollectionDigestSubs.$inferSelect;
