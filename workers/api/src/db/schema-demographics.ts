import {
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION_OPTIONS,
  type GenderOption,
  type SexualOrientationOption,
} from "@buildinternet/releases-api-types";
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema-auth.js";

export {
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION_OPTIONS,
  type GenderOption,
  type SexualOrientationOption,
};

/**
 * Per-user optional demographic fields — strictly opt-in for aggregate insights.
 *
 * Worker-local schema island (sibling of schema-digest-prefs.ts), deliberately
 * NOT in the published `@buildinternet/releases-core` schema. Queried via explicit
 * `.select().from(userDemographics)` on a `createDb(...)` handle.
 *
 * One row per user (`user_id` unique), created lazily on the first
 * `PUT /v1/me/demographics`. `opted_in` gates whether the row participates in
 * aggregate breakdowns; individual fields remain nullable. `birth_date` is an ISO
 * `YYYY-MM-DD` string when the user shares a full date; year-only shares set
 * `birth_year` with `birth_date` null. `user_id` cascades on account delete.
 *
 * Paired migration: 20260621000000_add_user_demographics.sql.
 */
export const userDemographics = sqliteTable(
  "user_demographics",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    optedIn: integer("opted_in", { mode: "boolean" }).notNull().default(false),
    birthYear: integer("birth_year"),
    birthDate: text("birth_date"),
    gender: text("gender"),
    genderCustom: text("gender_custom"),
    sexualOrientation: text("sexual_orientation"),
    sexualOrientationCustom: text("sexual_orientation_custom"),
    countryCode: text("country_code"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("idx_user_demographics_user").on(t.userId)],
);

export type UserDemographicsRow = typeof userDemographics.$inferSelect;
export type NewUserDemographicsRow = typeof userDemographics.$inferInsert;
