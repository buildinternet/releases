import { Hono } from "hono";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/db/schema-coverage.js";

type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
  };
};

export const releaseRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /releases?hasMedia=true — returns releases with non-empty media JSON
// Used by the `media backfill` CLI command.
// ---------------------------------------------------------------------------

releaseRoutes.get("/releases", async (c) => {
  const hasMedia = c.req.query("hasMedia");

  if (hasMedia === "true") {
    const db = createDb(c.env.DB);
    const rows = await db
      .select({
        id: releases.id,
        sourceId: releases.sourceId,
        media: releases.media,
      })
      .from(releases)
      .where(
        and(
          isNotNull(releases.media),
          sql`${releases.media} != '[]'`,
          sql`${releases.media} != ''`,
        )
      );

    return c.json(rows.filter((r) => r.media !== null));
  }

  return c.json({ error: "unsupported query — use ?hasMedia=true" }, 400);
});

// ---------------------------------------------------------------------------
// Release coverage
//
// Multiple releases can cover the same underlying launch (marketing post +
// platform changelog + app-version note). `release_coverage` records the
// canonical release plus every coverage row that rolls up into it.
//
// Auth note: these routes mount under /releases/* which is declared as a
// public-read group in index.ts, so GET is open and writes require the
// admin key. That policy lives in the mount, not in this file.
// ---------------------------------------------------------------------------

const DECIDED_BY_PATTERN = /^(human:|agent:)/;

releaseRoutes.get("/releases/:id/coverage", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");

  const [asCoverage] = await db.select().from(releaseCoverage)
    .where(eq(releaseCoverage.coverageId, id))
    .limit(1);
  if (asCoverage) {
    return c.json({ role: "coverage", canonical: asCoverage, covers: [] });
  }

  const covers = await db.select().from(releaseCoverage)
    .where(eq(releaseCoverage.canonicalId, id));
  if (covers.length > 0) {
    return c.json({ role: "canonical", canonical: null, covers });
  }

  return c.json({ role: "standalone", canonical: null, covers: [] });
});

releaseRoutes.post("/releases/:id/coverage", async (c) => {
  const db = createDb(c.env.DB);
  const canonicalId = c.req.param("id");

  type Body = { coverageIds?: string[]; reason?: string | null; decidedBy?: string };
  let body: Body;
  try {
    body = await c.req.json<Body>();
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  const coverageIds = Array.isArray(body.coverageIds) ? body.coverageIds : [];
  if (coverageIds.length === 0) {
    return c.json({ error: "bad_request", message: "coverageIds must be a non-empty array" }, 400);
  }
  if (!body.decidedBy || !DECIDED_BY_PATTERN.test(body.decidedBy)) {
    return c.json({ error: "bad_request", message: "decidedBy must be prefixed with 'human:' or 'agent:'" }, 400);
  }
  if (coverageIds.includes(canonicalId)) {
    return c.json({ error: "bad_request", message: "a release cannot be coverage of itself" }, 400);
  }

  const ids = [canonicalId, ...coverageIds];
  const found = await db.select({ id: releases.id }).from(releases)
    .where(inArray(releases.id, ids));
  const foundSet = new Set(found.map((r) => r.id));
  const missing = ids.filter((x) => !foundSet.has(x));
  if (missing.length > 0) {
    return c.json({ error: "not_found", message: `Release(s) not found: ${missing.join(", ")}` }, 404);
  }

  const now = new Date().toISOString();
  const reason = body.reason ?? null;
  const decidedBy = body.decidedBy;
  const rows = coverageIds.map((coverageId) => ({
    canonicalId, coverageId, reason, decidedBy, decidedAt: now,
  }));
  await db.insert(releaseCoverage).values(rows).onConflictDoUpdate({
    target: releaseCoverage.coverageId,
    set: { canonicalId, reason, decidedBy, decidedAt: now },
  });

  return c.json({ canonicalId, coverageIds, linked: coverageIds.length }, 201);
});

// DELETE is idempotent: returns { unlinked: false } when the release isn't in a
// cluster so the remote client can skip a brittle error-message sniff.
releaseRoutes.delete("/releases/:id/coverage", async (c) => {
  const db = createDb(c.env.DB);
  const coverageId = c.req.param("id");

  const deleted = await db.delete(releaseCoverage)
    .where(eq(releaseCoverage.coverageId, coverageId))
    .returning({ id: releaseCoverage.coverageId });

  return c.json({ unlinked: deleted.length > 0 });
});
