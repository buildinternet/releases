import { describe, expect, test } from "bun:test";
import { count, eq, lte } from "drizzle-orm";
import { idempotencyGuards } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper";
import { cronRuns } from "../src/db/schema-cron.js";
import { CRON_NAME, sweepIdempotencyRecords } from "../src/cron/sweep-idempotency-records.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");

type Db = ReturnType<typeof createTestDb>["db"];

async function seedGuard(db: Db, id: number, expiresAt: string): Promise<void> {
  await db.insert(idempotencyGuards).values({
    principalHash: `principal-${id}`.padEnd(64, "p"),
    keyHash: `key-${id}`.padEnd(64, "k"),
    requestHash: `request-${id}`.padEnd(64, "r"),
    state: "processing",
    attemptId: `attempt-${id}`,
    createdAt: "2026-08-23T12:00:00.000Z",
    expiresAt,
  });
}

async function guardCount(db: Db): Promise<number> {
  const [{ value }] = await db.select({ value: count() }).from(idempotencyGuards);
  return value;
}

describe("sweepIdempotencyRecords", () => {
  test("CRON_ENABLED=false does not create a run or delete an expired record", async () => {
    const { db } = createTestDb();
    await seedGuard(db, 1, "2026-08-24T11:59:59.999Z");

    await sweepIdempotencyRecords({
      DB: {} as D1Database,
      CRON_ENABLED: "false",
      _drizzleOverride: db,
      _now: NOW,
    });

    expect(await guardCount(db)).toBe(1);
    expect(await db.select().from(cronRuns).where(eq(cronRuns.cronName, CRON_NAME))).toEqual([]);
  });

  test("deletes at most one 500-record expired batch and records candidates and deletions", async () => {
    const { db } = createTestDb();
    for (let index = 0; index < 501; index++) {
      await seedGuard(db, index, "2026-08-24T11:59:59.999Z");
    }
    await seedGuard(db, 999, "2026-08-24T12:00:00.001Z");

    await sweepIdempotencyRecords({
      DB: {} as D1Database,
      _drizzleOverride: db,
      _now: NOW,
    });

    expect(await guardCount(db)).toBe(2);
    const [{ value: expiredRemaining }] = await db
      .select({ value: count() })
      .from(idempotencyGuards)
      .where(lte(idempotencyGuards.expiresAt, NOW.toISOString()));
    expect(expiredRemaining).toBe(1);
    const [run] = await db.select().from(cronRuns).where(eq(cronRuns.cronName, CRON_NAME));
    expect(run?.status).toBe("done");
    expect(run?.candidates).toBe(501);
    expect(run?.dispatched).toBe(500);
  });

  test("finalizes the cron run as aborted before rethrowing a deletion failure", async () => {
    const { db } = createTestDb();
    const brokenDb = Object.create(db) as Db;
    (brokenDb as unknown as { all: () => Promise<never> }).all = async () => {
      throw new Error("D1 unavailable");
    };

    await expect(
      sweepIdempotencyRecords({
        DB: {} as D1Database,
        _drizzleOverride: brokenDb,
        _now: NOW,
      }),
    ).rejects.toThrow("D1 unavailable");

    const [run] = await db.select().from(cronRuns).where(eq(cronRuns.cronName, CRON_NAME));
    expect(run?.status).toBe("aborted");
    expect(run?.dispatchErrors).toBe(1);
    expect(run?.notes).toContain("D1 unavailable");
  });
});
