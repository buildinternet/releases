import { describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { idempotencyGuards, idempotencyRecords } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../tests/db-helper";
import {
  claimIdempotency,
  completeIdempotency,
  releaseIdempotency,
  retainIdempotency,
  sweepExpiredIdempotency,
} from "../src/lib/idempotency-store";

const BASE = {
  principalHash: "p".repeat(64),
  keyHash: "k".repeat(64),
  requestHash: "r".repeat(64),
  attemptId: "attempt-one",
  now: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-25T12:00:00.000Z",
};

type StoreDb = Parameters<typeof claimIdempotency>[0];

function migratedDb() {
  const handle = createTestDb();
  return {
    ...handle,
    storeDb: handle.db as unknown as StoreDb,
  };
}

function scriptedAdmissionDb(input: {
  inserts: Array<Array<{ attemptId: string }>>;
  reads: Array<unknown[]>;
}) {
  let insertAttempts = 0;
  let reads = 0;

  const db = {
    insert() {
      return {
        values() {
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  return Promise.resolve(input.inserts[insertAttempts++] ?? []);
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(input.reads[reads++] ?? []);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as StoreDb;

  return {
    db,
    insertAttempts: () => insertAttempts,
    reads: () => reads,
  };
}

describe("idempotency store", () => {
  test("the first insert atomically creates an authoritative guard and response row", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      expect(await claimIdempotency(storeDb, BASE)).toEqual({
        kind: "claimed",
        attemptId: "attempt-one",
      });
      expect(await db.select().from(idempotencyGuards)).toHaveLength(1);
      expect(await db.select().from(idempotencyRecords)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("admission rolls back the guard if its response row cannot be created", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      await db.insert(idempotencyRecords).values({
        principalHash: BASE.principalHash,
        keyHash: BASE.keyHash,
        requestHash: BASE.requestHash,
        state: "processing",
        attemptId: "orphaned-attempt",
        createdAt: BASE.now,
        expiresAt: BASE.expiresAt,
      });

      await expect(claimIdempotency(storeDb, BASE)).rejects.toThrow();
      expect(await db.select().from(idempotencyGuards)).toHaveLength(0);
      expect(await db.select().from(idempotencyRecords)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("a matching duplicate observes the processing claim", async () => {
    const { storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);

      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-two",
        }),
      ).toEqual({ kind: "processing" });
    } finally {
      cleanup();
    }
  });

  test("a missing response row leaves the guard authoritative for matching retries", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);
      await db.delete(idempotencyRecords);

      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-two",
        }),
      ).toEqual({ kind: "processing" });
      expect(await db.select().from(idempotencyGuards)).toHaveLength(1);
      expect(await db.select().from(idempotencyRecords)).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("a completed guard with a missing response fails closed without reopening admission", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);
      await completeIdempotency(storeDb, {
        principalHash: BASE.principalHash,
        keyHash: BASE.keyHash,
        attemptId: BASE.attemptId,
        responseStatus: 201,
        responseHeaders: "{}",
        responseBody: "encrypted-response",
        completedAt: "2026-08-24T12:00:01.000Z",
      });
      await db.delete(idempotencyRecords);

      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-two",
        }),
      ).toEqual({ kind: "unavailable" });
      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          requestHash: "x".repeat(64),
          attemptId: "attempt-three",
        }),
      ).toEqual({ kind: "conflict" });
      expect(await db.select().from(idempotencyGuards)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("a duplicate with a different request hash conflicts", async () => {
    const { storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);

      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          requestHash: "x".repeat(64),
          attemptId: "attempt-two",
        }),
      ).toEqual({ kind: "conflict" });
    } finally {
      cleanup();
    }
  });

  test("a completed duplicate returns the stored response", async () => {
    const { storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);
      expect(
        await completeIdempotency(storeDb, {
          principalHash: BASE.principalHash,
          keyHash: BASE.keyHash,
          attemptId: BASE.attemptId,
          responseStatus: 201,
          responseHeaders: '{"content-type":"application/json"}',
          responseBody: "encrypted-response",
          completedAt: "2026-08-24T12:00:01.000Z",
        }),
      ).toBe(true);

      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-two",
        }),
      ).toEqual({
        kind: "completed",
        record: {
          requestHash: BASE.requestHash,
          responseStatus: 201,
          responseHeaders: '{"content-type":"application/json"}',
          responseBody: "encrypted-response",
          expiresAt: BASE.expiresAt,
        },
      });
    } finally {
      cleanup();
    }
  });

  test("completion transitions exactly one processing row", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);
      const completion = {
        principalHash: BASE.principalHash,
        keyHash: BASE.keyHash,
        attemptId: BASE.attemptId,
        responseStatus: 200,
        responseHeaders: "{}",
        responseBody: "encrypted-response",
        completedAt: "2026-08-24T12:00:01.000Z",
      };

      expect(await completeIdempotency(storeDb, completion)).toBe(true);
      expect(await completeIdempotency(storeDb, completion)).toBe(false);
      expect(
        await db
          .select({ state: idempotencyGuards.state, completedAt: idempotencyGuards.completedAt })
          .from(idempotencyGuards),
      ).toEqual([{ state: "completed", completedAt: completion.completedAt }]);
    } finally {
      cleanup();
    }
  });

  test("release deletes exactly one processing row and makes the key claimable", async () => {
    const { storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, BASE);
      const release = {
        principalHash: BASE.principalHash,
        keyHash: BASE.keyHash,
        attemptId: BASE.attemptId,
      };

      expect(await releaseIdempotency(storeDb, release)).toBe(true);
      expect(await releaseIdempotency(storeDb, release)).toBe(false);
      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-two",
        }),
      ).toEqual({ kind: "claimed", attemptId: "attempt-two" });
    } finally {
      cleanup();
    }
  });

  test("retention recreates a missing processing barrier with the original attempt", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      expect(await retainIdempotency(storeDb, BASE)).toBe(true);
      expect(
        await db
          .select({
            requestHash: idempotencyRecords.requestHash,
            state: idempotencyRecords.state,
            attemptId: idempotencyRecords.attemptId,
            createdAt: idempotencyRecords.createdAt,
            expiresAt: idempotencyRecords.expiresAt,
          })
          .from(idempotencyRecords),
      ).toEqual([
        {
          requestHash: "r".repeat(64),
          state: "processing",
          attemptId: "attempt-one",
          createdAt: "2026-08-24T12:00:00.000Z",
          expiresAt: "2026-08-25T12:00:00.000Z",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("retention preserves another live winner instead of overwriting its ownership", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, {
        ...BASE,
        requestHash: "x".repeat(64),
        attemptId: "attempt-new-winner",
      });

      expect(await retainIdempotency(storeDb, BASE)).toBe(true);
      expect(
        await db
          .select({
            requestHash: idempotencyRecords.requestHash,
            attemptId: idempotencyRecords.attemptId,
          })
          .from(idempotencyRecords),
      ).toEqual([
        {
          requestHash: "x".repeat(64),
          attemptId: "attempt-new-winner",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("an expired row is reclaimed without allowing its old attempt to mutate the new claim", async () => {
    const { storeDb, cleanup } = migratedDb();
    try {
      await claimIdempotency(storeDb, {
        ...BASE,
        now: "2026-08-23T12:00:00.000Z",
        expiresAt: "2026-08-24T12:00:00.000Z",
      });

      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-two",
        }),
      ).toEqual({ kind: "claimed", attemptId: "attempt-two" });

      const oldIdentity = {
        principalHash: BASE.principalHash,
        keyHash: BASE.keyHash,
        attemptId: BASE.attemptId,
      };
      expect(
        await completeIdempotency(storeDb, {
          ...oldIdentity,
          responseStatus: 200,
          responseHeaders: "{}",
          responseBody: "stale-response",
          completedAt: "2026-08-24T12:00:01.000Z",
        }),
      ).toBe(false);
      expect(await releaseIdempotency(storeDb, oldIdentity)).toBe(false);
      expect(
        await claimIdempotency(storeDb, {
          ...BASE,
          attemptId: "attempt-three",
        }),
      ).toEqual({ kind: "processing" });
    } finally {
      cleanup();
    }
  });

  test("a disappeared conflicting row retries admission and can win", async () => {
    const script = scriptedAdmissionDb({
      inserts: [[], [{ attemptId: BASE.attemptId }]],
      reads: [[]],
    });

    expect(await claimIdempotency(script.db, BASE)).toEqual({
      kind: "claimed",
      attemptId: BASE.attemptId,
    });
    expect(script.insertAttempts()).toBe(2);
    expect(script.reads()).toBe(1);
  });

  test("admission exhaustion returns unavailable after exactly three insert attempts", async () => {
    const script = scriptedAdmissionDb({
      inserts: [[], [], []],
      reads: [[], [], []],
    });

    expect(await claimIdempotency(script.db, BASE)).toEqual({ kind: "unavailable" });
    expect(script.insertAttempts()).toBe(3);
    expect(script.reads()).toBe(3);
  });

  test("sweep atomically deletes no more than the limit and keeps live rows", async () => {
    const { db, storeDb, cleanup } = migratedDb();
    try {
      const expirations = [
        ["a".repeat(64), "2026-08-24T08:00:00.000Z"],
        ["b".repeat(64), "2026-08-24T09:00:00.000Z"],
        ["c".repeat(64), "2026-08-24T10:00:00.000Z"],
        ["d".repeat(64), "2026-08-25T12:00:00.000Z"],
      ] as const;
      for (const [keyHash, expiresAt] of expirations) {
        await claimIdempotency(storeDb, {
          ...BASE,
          keyHash,
          attemptId: `attempt-${keyHash[0]}`,
          expiresAt,
        });
      }

      expect(
        await sweepExpiredIdempotency(storeDb, {
          now: BASE.now,
          limit: 2,
        }),
      ).toBe(2);
      expect(
        await db
          .select({ keyHash: idempotencyRecords.keyHash })
          .from(idempotencyRecords)
          .orderBy(asc(idempotencyRecords.expiresAt)),
      ).toEqual([{ keyHash: "c".repeat(64) }, { keyHash: "d".repeat(64) }]);
      expect(
        await db
          .select({ keyHash: idempotencyGuards.keyHash })
          .from(idempotencyGuards)
          .orderBy(asc(idempotencyGuards.expiresAt)),
      ).toEqual([{ keyHash: "c".repeat(64) }, { keyHash: "d".repeat(64) }]);
    } finally {
      cleanup();
    }
  });

  test("sweep rejects non-positive limits before issuing SQL", async () => {
    const dbThatMustNotBeTouched = new Proxy(
      {},
      {
        get() {
          throw new Error("database was touched");
        },
      },
    ) as StoreDb;

    await expect(
      sweepExpiredIdempotency(dbThatMustNotBeTouched, {
        now: BASE.now,
        limit: 0,
      }),
    ).rejects.toThrow();
  });
});
