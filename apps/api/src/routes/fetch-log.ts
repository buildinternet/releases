import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { fetchLog, sources } from "@buildinternet/releases-core/schema";
import { buildBareLimitEnvelope } from "../lib/pagination.js";
import { getStatusHub, sourceMatchByIdOrSlug } from "../utils.js";
import { getActiveFetchSession } from "../lib/active-fetch-session.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, ReleasesError, InternalError } from "@releases/lib/releases-error";
import { ingestFetchLog } from "../lib/fetch-log-ingest.js";

export { shouldBackoffScrapeFailure, failureBackoffHours } from "../lib/fetch-log-ingest.js";

export const fetchLogRoutes = new Hono<Env>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

fetchLogRoutes.get("/admin/logs/fetch", async (c) => {
  const db = createDb(c.env.DB);
  const sourceSlug = c.req.query("source");
  const rawLimit = parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const wantsEnvelope = c.req.query("envelope") === "true";

  if (sourceSlug) {
    const [src] = await db.select().from(sources).where(sourceMatchByIdOrSlug(sourceSlug));
    if (!src) return respondError(c, new NotFoundError("Source not found"));

    const logs = await db
      .select()
      .from(fetchLog)
      .where(eq(fetchLog.sourceId, src.id))
      .orderBy(desc(fetchLog.createdAt))
      .limit(limit);
    if (!wantsEnvelope) return c.json(logs);
    // Overlay the live in-flight fetch (#1360). fetch_log only records terminal
    // states, so during a multi-minute crawl the history above shows nothing
    // newer; `activeSession` lets a single enveloped poll tell "still running"
    // from "stuck/dead". Bare-array form (above) stays unchanged for back-compat.
    const activeSession = await getActiveFetchSession(getStatusHub(c.env), src.slug);
    return c.json({ ...buildBareLimitEnvelope(logs, limit), activeSession });
  }

  const logs = await db.select().from(fetchLog).orderBy(desc(fetchLog.createdAt)).limit(limit);
  return wantsEnvelope ? c.json(buildBareLimitEnvelope(logs, limit)) : c.json(logs);
});

fetchLogRoutes.post("/admin/logs/fetch", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  try {
    const row = await ingestFetchLog(db, c.env, body);
    return c.json(row, 201);
  } catch (err) {
    if (err instanceof ReleasesError) return respondError(c, err);
    return respondError(c, new InternalError("Failed to insert fetch log"));
  }
});
