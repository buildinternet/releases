import { and, eq, lte, sql } from "drizzle-orm";
import { idempotencyRecords } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";

export type IdempotencyState = "processing" | "completed";

export interface CompletedIdempotencyRecord {
  requestHash: string;
  responseStatus: number;
  responseHeaders: string;
  responseBody: string;
  expiresAt: string;
}

export type ClaimResult =
  | { kind: "claimed"; attemptId: string }
  | { kind: "completed"; record: CompletedIdempotencyRecord }
  | { kind: "processing" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

type Db = ReturnType<typeof createDb>;

const MAX_ADMISSION_ATTEMPTS = 3;

export async function claimIdempotency(
  db: Db,
  input: {
    principalHash: string;
    keyHash: string;
    requestHash: string;
    attemptId: string;
    now: string;
    expiresAt: string;
  },
): Promise<ClaimResult> {
  for (let admissionAttempt = 0; admissionAttempt < MAX_ADMISSION_ATTEMPTS; admissionAttempt++) {
    const inserted = await db
      .insert(idempotencyRecords)
      .values({
        principalHash: input.principalHash,
        keyHash: input.keyHash,
        requestHash: input.requestHash,
        state: "processing",
        attemptId: input.attemptId,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing()
      .returning({ attemptId: idempotencyRecords.attemptId });

    if (inserted.length === 1) {
      return { kind: "claimed", attemptId: inserted[0].attemptId };
    }

    const [existing] = await db
      .select({
        requestHash: idempotencyRecords.requestHash,
        state: idempotencyRecords.state,
        attemptId: idempotencyRecords.attemptId,
        expiresAt: idempotencyRecords.expiresAt,
        responseStatus: idempotencyRecords.responseStatus,
        responseHeaders: idempotencyRecords.responseHeaders,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.principalHash, input.principalHash),
          eq(idempotencyRecords.keyHash, input.keyHash),
        ),
      )
      .limit(1);

    if (!existing) {
      continue;
    }

    if (existing.expiresAt <= input.now) {
      await db
        .delete(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.principalHash, input.principalHash),
            eq(idempotencyRecords.keyHash, input.keyHash),
            lte(idempotencyRecords.expiresAt, input.now),
          ),
        )
        .returning({ attemptId: idempotencyRecords.attemptId });
      continue;
    }

    if (existing.requestHash !== input.requestHash) {
      return { kind: "conflict" };
    }

    if (existing.state === "processing") {
      return { kind: "processing" };
    }

    if (
      existing.responseStatus === null ||
      existing.responseHeaders === null ||
      existing.responseBody === null
    ) {
      return { kind: "unavailable" };
    }

    return {
      kind: "completed",
      record: {
        requestHash: existing.requestHash,
        responseStatus: existing.responseStatus,
        responseHeaders: existing.responseHeaders,
        responseBody: existing.responseBody,
        expiresAt: existing.expiresAt,
      },
    };
  }

  return { kind: "unavailable" };
}

export async function completeIdempotency(
  db: Db,
  input: {
    principalHash: string;
    keyHash: string;
    attemptId: string;
    responseStatus: number;
    responseHeaders: string;
    responseBody: string;
    completedAt: string;
  },
): Promise<boolean> {
  const completed = await db
    .update(idempotencyRecords)
    .set({
      state: "completed",
      responseStatus: input.responseStatus,
      responseHeaders: input.responseHeaders,
      responseBody: input.responseBody,
      completedAt: input.completedAt,
    })
    .where(
      and(
        eq(idempotencyRecords.principalHash, input.principalHash),
        eq(idempotencyRecords.keyHash, input.keyHash),
        eq(idempotencyRecords.attemptId, input.attemptId),
        eq(idempotencyRecords.state, "processing"),
      ),
    )
    .returning();

  return completed.length === 1;
}

export async function releaseIdempotency(
  db: Db,
  input: { principalHash: string; keyHash: string; attemptId: string },
): Promise<boolean> {
  const released = await db
    .delete(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.principalHash, input.principalHash),
        eq(idempotencyRecords.keyHash, input.keyHash),
        eq(idempotencyRecords.attemptId, input.attemptId),
        eq(idempotencyRecords.state, "processing"),
      ),
    )
    .returning();

  return released.length === 1;
}

/**
 * Cheap confirmation that a claimed guard row is still there in `processing`
 * state — a single indexed SELECT, for the common case where a guard we
 * claimed was never deleted and doesn't need the full {@link claimIdempotency}
 * admission loop to "retain" it.
 */
export async function isGuardActive(
  db: Db,
  input: { principalHash: string; keyHash: string; attemptId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ attemptId: idempotencyRecords.attemptId })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.principalHash, input.principalHash),
        eq(idempotencyRecords.keyHash, input.keyHash),
        eq(idempotencyRecords.attemptId, input.attemptId),
        eq(idempotencyRecords.state, "processing"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function retainIdempotency(
  db: Db,
  input: {
    principalHash: string;
    keyHash: string;
    requestHash: string;
    attemptId: string;
    now: string;
    expiresAt: string;
  },
): Promise<boolean> {
  const retained = await claimIdempotency(db, input);
  return retained.kind !== "unavailable";
}

export async function sweepExpiredIdempotency(
  db: Db,
  input: { now: string; limit: number },
): Promise<number> {
  if (input.limit <= 0) {
    throw new RangeError("idempotency sweep limit must be positive");
  }

  const deleted = await db.all<{ rowid: number }>(sql`
    DELETE FROM idempotency_records
    WHERE rowid IN (
      SELECT rowid
      FROM idempotency_records
      WHERE expires_at <= ${input.now}
      ORDER BY expires_at
      LIMIT ${input.limit}
    )
    RETURNING rowid
  `);

  return deleted.length;
}
