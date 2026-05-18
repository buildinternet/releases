/**
 * Admin-only routes for batch_runs observability.
 * Gated via the "admin/batch-runs" entry in route-namespaces.ts / adminRoutes.
 *
 * GET  /admin/batch-runs        — page-based list (Pagination shape)
 * GET  /admin/batch-runs/:id    — detail row (includes full error_summary + caller_context)
 * POST /admin/batch-runs        — create row at batch submission (called by the script)
 * PATCH /admin/batch-runs/:id   — update row on poll / finalize (called by the script)
 */

import { Hono } from "hono";
import { count, desc, eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { batchRuns } from "@buildinternet/releases-core/schema";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";
import { logEvent } from "@releases/lib/log-event";
import { classifyDbError } from "@releases/lib/db-errors";
import type { Env } from "../index.js";

export const adminBatchRunsRoutes = new Hono<Env>();

// ── GET /admin/batch-runs ─────────────────────────────────────────────────────

adminBatchRunsRoutes.get("/admin/batch-runs", async (c) => {
  const db = createDb(c.env.DB);
  const p = parseListPagination(new URLSearchParams(c.req.url.split("?")[1] ?? ""), {
    defaultPageSize: 25,
    maxPageSize: 100,
  });

  const [[totalRow], rows] = await Promise.all([
    db.select({ n: count() }).from(batchRuns),
    db
      .select({
        id: batchRuns.id,
        anthropicBatchId: batchRuns.anthropicBatchId,
        caller: batchRuns.caller,
        model: batchRuns.model,
        status: batchRuns.status,
        requestCountTotal: batchRuns.requestCountTotal,
        requestCountSucceeded: batchRuns.requestCountSucceeded,
        requestCountErrored: batchRuns.requestCountErrored,
        requestCountExpired: batchRuns.requestCountExpired,
        requestCountCanceled: batchRuns.requestCountCanceled,
        createdAt: batchRuns.createdAt,
        endedAt: batchRuns.endedAt,
        estCostUsd: batchRuns.estCostUsd,
        actualCostUsd: batchRuns.actualCostUsd,
      })
      .from(batchRuns)
      .orderBy(desc(batchRuns.createdAt))
      .limit(p.pageSize)
      .offset(p.offset),
  ]);
  const totalItems = totalRow?.n ?? 0;

  return c.json(buildListResponse(rows, p, totalItems));
});

// ── GET /admin/batch-runs/:id ─────────────────────────────────────────────────

adminBatchRunsRoutes.get("/admin/batch-runs/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const [row] = await db.select().from(batchRuns).where(eq(batchRuns.id, id));
  if (!row) return c.json({ error: "not_found" }, 404);

  // Deserialize JSON columns for richer downstream rendering.
  const errorSummary = row.errorSummary ? JSON.parse(row.errorSummary) : null;
  const callerContext = row.callerContext ? JSON.parse(row.callerContext) : null;

  return c.json({ ...row, errorSummary, callerContext });
});

// ── POST /admin/batch-runs ────────────────────────────────────────────────────

/**
 * Called by the generate-release-content script immediately after submitBatch.
 * Body mirrors the BatchSubmitFields shape used by recordBatchSubmit.
 */
adminBatchRunsRoutes.post("/admin/batch-runs", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const anthropicBatchId = typeof body.anthropicBatchId === "string" ? body.anthropicBatchId : null;
  const CALLERS = ["script", "workflow", "admin"] as const;
  type Caller = (typeof CALLERS)[number];
  const caller: Caller | null =
    typeof body.caller === "string" && (CALLERS as readonly string[]).includes(body.caller)
      ? (body.caller as Caller)
      : null;
  const model = typeof body.model === "string" ? body.model : null;
  const requestCountTotal =
    typeof body.requestCountTotal === "number" &&
    Number.isFinite(body.requestCountTotal) &&
    body.requestCountTotal >= 0
      ? body.requestCountTotal
      : null;

  if (!anthropicBatchId || !caller || !model || requestCountTotal === null) {
    return c.json({ error: "missing_required_fields" }, 400);
  }

  const estCostUsdRaw = body.estCostUsd;
  if (
    estCostUsdRaw !== undefined &&
    estCostUsdRaw !== null &&
    !(typeof estCostUsdRaw === "number" && Number.isFinite(estCostUsdRaw) && estCostUsdRaw >= 0)
  ) {
    return c.json({ error: "bad_request" }, 400);
  }
  const estCostUsd =
    typeof estCostUsdRaw === "number" && Number.isFinite(estCostUsdRaw) ? estCostUsdRaw : null;
  const callerContext =
    body.callerContext && typeof body.callerContext === "object"
      ? JSON.stringify(body.callerContext)
      : null;

  const db = createDb(c.env.DB);
  try {
    const [inserted] = await db
      .insert(batchRuns)
      .values({
        anthropicBatchId,
        caller,
        model,
        status: "submitted",
        requestCountTotal,
        estCostUsd,
        callerContext,
      })
      .returning({ id: batchRuns.id });

    return c.json({ id: inserted!.id }, 201);
  } catch (err) {
    const classified = classifyDbError(err);
    logEvent("error", {
      component: "admin-batch-runs",
      event: "insert-failed",
      anthropicBatchId,
      err,
      ...(classified
        ? {
            causeCode: classified.code,
            causeMessage: classified.message,
            causeTransient: classified.transient,
          }
        : {}),
    });
    return c.json(
      { error: "insert_failed", ...(classified ? { errorCode: classified.code } : {}) },
      500,
    );
  }
});

// ── PATCH /admin/batch-runs/:id ───────────────────────────────────────────────

/**
 * Called by the generate-release-content script on each poll tick and at
 * finalization. Accepts a partial update — only provided fields are written.
 */
adminBatchRunsRoutes.patch("/admin/batch-runs/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Build the partial update from provided fields.
  const patch: Partial<typeof batchRuns.$inferInsert> = {};

  if (typeof body.status === "string") {
    const s = body.status as (typeof batchRuns.$inferInsert)["status"];
    if (["submitted", "in_progress", "ended", "failed"].includes(s)) patch.status = s;
  }

  // Validate and assign non-negative finite integers for request counts.
  const countFields = [
    ["requestCountSucceeded", "requestCountSucceeded"],
    ["requestCountErrored", "requestCountErrored"],
    ["requestCountExpired", "requestCountExpired"],
    ["requestCountCanceled", "requestCountCanceled"],
  ] as const;
  for (const [bodyKey, patchKey] of countFields) {
    const v = body[bodyKey];
    if (v !== undefined) {
      if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) {
        return c.json({ error: "bad_request" }, 400);
      }
      patch[patchKey] = v;
    }
  }

  if (typeof body.endedAt === "string") patch.endedAt = body.endedAt;

  if (body.actualCostUsd !== undefined) {
    if (body.actualCostUsd === null) {
      patch.actualCostUsd = null;
    } else if (
      typeof body.actualCostUsd === "number" &&
      Number.isFinite(body.actualCostUsd) &&
      body.actualCostUsd >= 0
    ) {
      patch.actualCostUsd = body.actualCostUsd;
    } else {
      return c.json({ error: "bad_request" }, 400);
    }
  }

  if (body.errorSummary !== undefined) {
    patch.errorSummary =
      body.errorSummary && typeof body.errorSummary === "object"
        ? JSON.stringify(body.errorSummary)
        : null;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no_fields_to_update" }, 400);
  }

  const db = createDb(c.env.DB);
  try {
    const result = await db.update(batchRuns).set(patch).where(eq(batchRuns.id, id));
    if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    const classified = classifyDbError(err);
    logEvent("error", {
      component: "admin-batch-runs",
      event: "update-failed",
      id,
      err,
      ...(classified
        ? {
            causeCode: classified.code,
            causeMessage: classified.message,
            causeTransient: classified.transient,
          }
        : {}),
    });
    return c.json(
      { error: "update_failed", ...(classified ? { errorCode: classified.code } : {}) },
      500,
    );
  }
});
