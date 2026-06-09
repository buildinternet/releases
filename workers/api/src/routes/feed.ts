import { Hono } from "hono";
import { createDb } from "../db.js";
import { resolveFeedToken, touchFeedTokenLastUsed } from "../queries/feed-tokens.js";
import { getFollowedReleases, mapLatestRowToReleaseItem } from "../queries/releases.js";
import { parseFeedToken } from "@buildinternet/releases-core/api-token";
import { userFeedToAtom, ATOM_DEFAULT_MAX_ENTRIES } from "@releases/rendering/atom.js";
import { atomEtag, formatLastModified, shouldReturn304 } from "@releases/rendering/atom-http.js";
import type { Env } from "../index.js";

export const feedRoutes = new Hono<Env>();

/**
 * Public, token-authenticated personalized Atom feed. The `relf_` secret rides
 * in the path (a feed reader can't send a cookie/header). Any failure to resolve
 * → 404 (opaque, non-enumerable). The feed serves only public release data.
 */
feedRoutes.get("/feed/:token", async (c) => {
  // Strip an optional .atom/.rss suffix; both serve Atom (every reader accepts it).
  const raw = c.req.param("token").replace(/\.(atom|rss)$/, "");
  const parsed = parseFeedToken(raw);
  if (!parsed) return c.json({ error: "not_found" }, 404);

  const db = createDb(c.env.DB);
  const userId = await resolveFeedToken(db, raw);
  if (!userId) return c.json({ error: "not_found" }, 404);

  const rows = await getFollowedReleases(db, userId, {
    limit: ATOM_DEFAULT_MAX_ENTRIES,
    offset: 0,
  });
  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releases = rows.map((r) => mapLatestRowToReleaseItem(r, mediaOrigin));

  const baseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";
  const selfUrl = `${new URL(c.req.url).origin}/v1/feed/${raw}.atom`;
  const body = userFeedToAtom({ releases, lookupId: parsed.lookupId, selfUrl }, { baseUrl });

  // Best-effort last_used_at — never block or fail the response.
  // Hono's executionCtx getter throws (not returns undefined) when absent (e.g.
  // in unit tests), so guard with try/catch rather than optional chaining.
  try {
    c.executionCtx.waitUntil(touchFeedTokenLastUsed(db, parsed.lookupId).catch(() => {}));
  } catch {
    // No execution context (unit test or non-Worker runtime) — fire-and-forget inline.
    void touchFeedTokenLastUsed(db, parsed.lookupId).catch(() => {});
  }

  const etag = atomEtag(body);
  const lastModified = formatLastModified(
    releases.length ? (releases[0].publishedAt ?? null) : null,
  );
  if (
    shouldReturn304(
      etag,
      lastModified,
      c.req.header("if-none-match") ?? null,
      c.req.header("if-modified-since") ?? null,
    )
  ) {
    return c.body(null, 304, { ETag: etag });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/atom+xml; charset=utf-8",
    "Cache-Control": "private, no-store",
    ETag: etag,
  };
  if (lastModified) headers["Last-Modified"] = lastModified;
  return c.body(body, 200, headers);
});
