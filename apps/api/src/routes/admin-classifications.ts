/**
 * Admin read API for marketing-classification analytics stored in
 * Analytics Engine. Gated by authMiddleware via the "admin/classifications"
 * entry in route-namespaces.ts.
 *
 *   GET /admin/classifications/summary — sampled aggregates, cached 45s
 *   GET /admin/classifications/recent  — sampled rows, hydrated from D1
 *
 * Summary caching uses LATEST_CACHE directly. It is not the public
 * /v1/releases/latest cache: no invalidateLatestCache, no cacheControl.
 * Admin requests carry Authorization and stay out of the shared edge cache.
 */
import { Hono } from "hono";
import { ReleasesError, ValidationError } from "@releases/lib/releases-error";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { classificationDatasetName } from "../lib/classification/classification-schema.js";
import {
  SUMMARY_CACHE_KV_TTL_SECONDS,
  fetchClassificationRecent,
  fetchClassificationSummary,
  parseRecentQuery,
  parseSummaryQuery,
  readSummaryCache,
  summaryCacheEntry,
  summaryCacheKey,
  summaryCacheMaterial,
} from "../lib/classification/classification-query.js";
import { respondError } from "../lib/error-response.js";

export const adminClassificationsRoutes = new Hono<Env>();

// Test seam, same shape as admin-search-queries: tests inject db / fetch.
function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

function getAeFetch(c: any): typeof fetch {
  return c.get("aeFetch") ?? fetch;
}

adminClassificationsRoutes.get("/admin/classifications/summary", async (c) => {
  const now = Date.now();
  const parsed = parseSummaryQuery(
    {
      after: c.req.query("after"),
      before: c.req.query("before"),
      bucket: c.req.query("bucket"),
      origin: c.req.query("origin"),
      model: c.req.query("model"),
      sourceId: c.req.query("sourceId"),
    },
    now,
  );
  if (parsed instanceof ValidationError) return respondError(c, parsed);

  const dataset = classificationDatasetName(c.env?.ENVIRONMENT);
  const key = await summaryCacheKey(summaryCacheMaterial(parsed, dataset));
  // KV's minimum expirationTtl is 60s. The entry stores its own timestamp and
  // reads treat anything older than 45s as a miss, so the operator window
  // stays 45s even though the key lives until the KV floor.
  const kv = c.env?.LATEST_CACHE;
  if (kv) {
    const cached = readSummaryCache(await kv.get(key, "json").catch(() => null), Date.now());
    if (cached) return c.json(cached);
  }

  const result = await fetchClassificationSummary(c.env, parsed, getAeFetch(c));
  if (result instanceof ReleasesError) return respondError(c, result);

  if (kv) {
    await kv
      .put(key, summaryCacheEntry(result, Date.now()), {
        expirationTtl: SUMMARY_CACHE_KV_TTL_SECONDS,
      })
      .catch(() => undefined);
  }
  return c.json(result);
});

adminClassificationsRoutes.get("/admin/classifications/recent", async (c) => {
  const parsed = parseRecentQuery({
    after: c.req.query("after"),
    before: c.req.query("before"),
    origin: c.req.query("origin"),
    choice: c.req.query("choice"),
    disposition: c.req.query("disposition"),
    sourceId: c.req.query("sourceId"),
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });
  if (parsed instanceof ValidationError) return respondError(c, parsed);

  const result = await fetchClassificationRecent(c.env, getDb(c), parsed, getAeFetch(c));
  if (result instanceof ReleasesError) return respondError(c, result);
  return c.json(result);
});
