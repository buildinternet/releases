import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

/**
 * User follows — a signed-in user following an organization or a product.
 *
 * Worker-local schema island (sibling of schema-auth.ts), deliberately NOT in
 * the published `@buildinternet/releases-core` schema: this is user-coupled data
 * the OSS CLI has no business with. Queried via explicit `.select().from(userFollows)`
 * on a `createDb(...)` handle — the core schema map doesn't include it, but
 * drizzle's `.from(table)` works with any table object (only the relational
 * `db.query.*` API needs the schema map).
 *
 * `target` is polymorphic — `(target_type, target_id)` points at either an
 * organization (`org_…`) or a product (`prd_…`). No hard FK on `target_id`
 * (one column can't reference two tables); orgs/products are soft-deleted and the
 * feed query inner-joins to live entities, so an orphaned follow is invisible,
 * never broken. `user_id` keeps a real cascade FK so deleting an account removes
 * its follows.
 *
 * Paired migration: 20260608000000_add_user_follows.sql.
 */
export const FOLLOW_TARGET_TYPES = ["org", "product"] as const;
export type FollowTargetType = (typeof FOLLOW_TARGET_TYPES)[number];

export const userFollows = sqliteTable(
  "user_follows",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetType: text("target_type", { enum: FOLLOW_TARGET_TYPES }).notNull(),
    targetId: text("target_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("idx_user_follows_unique").on(t.userId, t.targetType, t.targetId),
    index("idx_user_follows_user").on(t.userId),
    index("idx_user_follows_target").on(t.targetType, t.targetId),
  ],
);

export type UserFollow = typeof userFollows.$inferSelect;
export type NewUserFollow = typeof userFollows.$inferInsert;
