/**
 * Tests for batch_runs persistence helpers.
 *
 * Coverage:
 * 1. recordBatchSubmit inserts a row with status "submitted"
 * 2. recordBatchProgress updates counts + status "in_progress"
 * 3. recordBatchFinalize stamps ended_at, counts, cost, status "ended"
 * 4. cost-on-failure: actualCostUsd = null when no requests ran
 * 5. errorSummary is serialized correctly
 * 6. callerContext is serialized correctly
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
// Import directly from the source file rather than via the package alias so the
// test picks up the worktree's version of schema.ts (the symlinked
// node_modules/@buildinternet/releases-core -> ../../packages/core resolves to
// the main repo, which may not yet have these exports).
import { batchRuns } from "../../core/src/schema.js";
import {
  recordBatchSubmit,
  recordBatchProgress,
  recordBatchFinalize,
  type BatchSubmitFields,
} from "./batch-run.js";

// Cast the bun-sqlite TestDb to the type our helpers accept. The helpers
// receive a DrizzleD1Database but work identically with drizzle/bun-sqlite.
const asDb = (db: TestDatabase["db"]): any => db as any;

const BASE_SUBMIT: BatchSubmitFields = {
  anthropicBatchId: "msgbatch_test_001",
  caller: "script",
  model: "claude-haiku-4-5-20251001",
  requestCountTotal: 10,
  estCostUsd: 0.05,
  callerContext: { orgs: ["openai", "anthropic"], since_days: 7 },
};

describe("recordBatchSubmit", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
    // batch_runs has no FK dependencies; a simple delete clears it.
    tdb.db.delete(batchRuns).run();
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("inserts a row and returns a bat_ prefixed id", async () => {
    const id = await recordBatchSubmit(asDb(tdb.db), BASE_SUBMIT);
    expect(id).toMatch(/^bat_/);
  });

  it("row has status 'submitted' and correct caller/model", async () => {
    const id = await recordBatchSubmit(asDb(tdb.db), BASE_SUBMIT);
    const [row] = await tdb.db.select().from(batchRuns).where(eq(batchRuns.id, id));
    expect(row).toBeDefined();
    expect(row!.status).toBe("submitted");
    expect(row!.caller).toBe("script");
    expect(row!.model).toBe("claude-haiku-4-5-20251001");
    expect(row!.anthropicBatchId).toBe("msgbatch_test_001");
    expect(row!.requestCountTotal).toBe(10);
    expect(row!.estCostUsd).toBeCloseTo(0.05);
  });

  it("serializes callerContext as JSON string", async () => {
    const id = await recordBatchSubmit(asDb(tdb.db), BASE_SUBMIT);
    const [row] = await tdb.db.select().from(batchRuns).where(eq(batchRuns.id, id));
    const ctx = JSON.parse(row!.callerContext!);
    expect(ctx).toEqual({ orgs: ["openai", "anthropic"], since_days: 7 });
  });

  it("handles null callerContext", async () => {
    const id = await recordBatchSubmit(asDb(tdb.db), {
      ...BASE_SUBMIT,
      anthropicBatchId: "msgbatch_no_ctx",
      callerContext: null,
    });
    const [row] = await tdb.db.select().from(batchRuns).where(eq(batchRuns.id, id));
    expect(row!.callerContext).toBeNull();
  });
});

describe("recordBatchProgress", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
    tdb.db.delete(batchRuns).run();
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("updates status to in_progress and sets counts", async () => {
    await recordBatchSubmit(asDb(tdb.db), {
      ...BASE_SUBMIT,
      anthropicBatchId: "msgbatch_prog_001",
    });

    await recordBatchProgress(asDb(tdb.db), "msgbatch_prog_001", {
      succeeded: 3,
      errored: 1,
      expired: 0,
      canceled: 0,
    });

    const [row] = await tdb.db
      .select()
      .from(batchRuns)
      .where(eq(batchRuns.anthropicBatchId, "msgbatch_prog_001"));
    expect(row!.status).toBe("in_progress");
    expect(row!.requestCountSucceeded).toBe(3);
    expect(row!.requestCountErrored).toBe(1);
    expect(row!.requestCountExpired).toBe(0);
    expect(row!.requestCountCanceled).toBe(0);
  });
});

describe("recordBatchFinalize", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
    tdb.db.delete(batchRuns).run();
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("stamps ended_at, status 'ended', and actualCostUsd", async () => {
    await recordBatchSubmit(asDb(tdb.db), {
      ...BASE_SUBMIT,
      anthropicBatchId: "msgbatch_final_001",
    });

    const endedAt = new Date().toISOString();
    await recordBatchFinalize(asDb(tdb.db), "msgbatch_final_001", {
      status: "ended",
      endedAt,
      counts: { succeeded: 10, errored: 0, expired: 0, canceled: 0 },
      actualCostUsd: 0.04,
    });

    const [row] = await tdb.db
      .select()
      .from(batchRuns)
      .where(eq(batchRuns.anthropicBatchId, "msgbatch_final_001"));
    expect(row!.status).toBe("ended");
    expect(row!.endedAt).toBe(endedAt);
    expect(row!.actualCostUsd).toBeCloseTo(0.04);
    expect(row!.requestCountSucceeded).toBe(10);
    expect(row!.errorSummary).toBeNull();
  });

  it("cost-on-failure: actualCostUsd = null when zero requests ran", async () => {
    await recordBatchSubmit(asDb(tdb.db), {
      ...BASE_SUBMIT,
      anthropicBatchId: "msgbatch_expired_001",
      requestCountTotal: 5,
    });

    await recordBatchFinalize(asDb(tdb.db), "msgbatch_expired_001", {
      status: "ended",
      endedAt: new Date().toISOString(),
      counts: { succeeded: 0, errored: 0, expired: 5, canceled: 0 },
      actualCostUsd: null, // zero ran → null
    });

    const [row] = await tdb.db
      .select()
      .from(batchRuns)
      .where(eq(batchRuns.anthropicBatchId, "msgbatch_expired_001"));
    expect(row!.actualCostUsd).toBeNull();
    expect(row!.requestCountExpired).toBe(5);
  });

  it("serializes errorSummary as JSON string when errored > 0", async () => {
    await recordBatchSubmit(asDb(tdb.db), {
      ...BASE_SUBMIT,
      anthropicBatchId: "msgbatch_err_001",
    });

    await recordBatchFinalize(asDb(tdb.db), "msgbatch_err_001", {
      status: "ended",
      endedAt: new Date().toISOString(),
      counts: { succeeded: 8, errored: 2, expired: 0, canceled: 0 },
      actualCostUsd: 0.032,
      errorSummary: { sample: ["err1", "err2"] },
    });

    const [row] = await tdb.db
      .select()
      .from(batchRuns)
      .where(eq(batchRuns.anthropicBatchId, "msgbatch_err_001"));
    expect(row!.requestCountErrored).toBe(2);
    const parsed = JSON.parse(row!.errorSummary!);
    expect(parsed).toEqual({ sample: ["err1", "err2"] });
  });
});
