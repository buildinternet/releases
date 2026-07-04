import { Hono } from "hono";
import { createDb } from "../db.js";
import { resolveFeedToken, touchFeedTokenLastUsed, feedAtomUrl } from "../queries/feed-tokens.js";
import {
  getFollowedReleases,
  mapLatestRowToReleaseItem,
  releaseWebBase,
} from "../queries/releases.js";
import { userFeedToAtom, ATOM_DEFAULT_MAX_ENTRIES } from "@releases/rendering/atom.js";
import { atomEtag, formatLastModified, shouldReturn304 } from "@releases/rendering/atom-http.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError } from "@releases/lib/releases-error";

export const feedRoutes = new Hono<Env>();

/**
 * Public, token-authenticated personalized Atom feed. The `relf_` secret rides
 * in the path (a feed reader can't send a cookie/header). Any failure to resolve
 * → 404 (opaque, non-enumerable). The feed serves only public release data.
 */
feedRoutes.get("/feed/:token", async (c) => {
  // Strip an optional .atom/.rss suffix; both serve Atom (every reader accepts it).
  const raw = c.req.param("token").replace(/\.(atom|rss)$/, "");

  const db = createDb(c.env.DB);
  const resolved = await resolveFeedToken(db, raw);
  if (!resolved) return respondError(c, new NotFoundError());

  const rows = await getFollowedReleases(db, resolved.userId, {
    limit: ATOM_DEFAULT_MAX_ENTRIES,
  });
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releases = rows.map((r) =>
    mapLatestRowToReleaseItem(r, mediaOrigin, releaseWebBase(c.env)),
  );

  const baseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";
  const selfUrl = feedAtomUrl(new URL(c.req.url).origin, raw);
  const body = userFeedToAtom({ releases, lookupId: resolved.lookupId, selfUrl }, { baseUrl });

  // Best-effort last_used_at — never block or fail the response.
  // Hono's executionCtx getter throws (not returns undefined) when absent (e.g.
  // in unit tests), so guard with try/catch rather than optional chaining.
  try {
    c.executionCtx.waitUntil(touchFeedTokenLastUsed(db, resolved.lookupId).catch(() => {}));
  } catch {
    // No execution context (unit test or non-Worker runtime) — fire-and-forget inline.
    void touchFeedTokenLastUsed(db, resolved.lookupId).catch(() => {});
  }

  const etag = atomEtag(body);
  const lastModified = formatLastModified(
    releases.length ? (releases[0].publishedAt ?? null) : null,
  );

  // Validator + cache headers shared by the 200 and 304 responses so a
  // conditional GET preserves the same caching contract either way.
  const cacheHeaders: Record<string, string> = {
    "Cache-Control": "private, no-store",
    ETag: etag,
  };
  if (lastModified) cacheHeaders["Last-Modified"] = lastModified;

  if (
    shouldReturn304(
      etag,
      lastModified,
      c.req.header("if-none-match") ?? null,
      c.req.header("if-modified-since") ?? null,
    )
  ) {
    return c.body(null, 304, cacheHeaders);
  }

  return c.body(body, 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
    ...cacheHeaders,
  });
});
