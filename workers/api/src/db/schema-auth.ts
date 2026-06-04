import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Better Auth core schema — `user` / `session` / `account` / `verification`.
 *
 * This is a **worker-local** schema island, deliberately NOT added to the
 * published `@buildinternet/releases-core` schema map (the OSS CLI consumes that
 * package and has no business with auth tables). The Drizzle table objects are
 * handed directly to Better Auth's `drizzleAdapter({ schema })`, so they don't
 * need to live in `createDb`'s schema map to be queryable by the adapter.
 *
 * Column names are snake_case to match repo convention; the JS property keys are
 * the camelCase names Better Auth expects (the adapter resolves fields by key).
 * Timestamps use Drizzle's integer `timestamp` mode and booleans the integer
 * `boolean` mode — this is Better Auth's canonical Drizzle/SQLite shape, which
 * round-trips `Date`/`boolean` through the adapter cleanly (the repo's app tables
 * use ISO-text timestamps, but auth tables follow Better Auth's expectations).
 *
 * Paired migration: workers/api/migrations/20260604000000_add_better_auth_tables.sql
 * (the schema↔migration pairing gate in ci.yml watches this file).
 */

/** A non-null integer `timestamp` column with a JS-side default (Better Auth sets these too). */
const timestampCol = (name: string) =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => false),
  image: text("image"),
  createdAt: timestampCol("created_at"),
  updatedAt: timestampCol("updated_at"),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_session_user_id").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    idToken: text("id_token"),
    // Credential (email/password) accounts store the hashed password here.
    password: text("password"),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_account_user_id").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_verification_identifier").on(t.identifier)],
);

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthVerification = typeof verification.$inferSelect;
