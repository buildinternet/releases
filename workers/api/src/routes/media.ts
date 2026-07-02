import { Hono } from "hono";
import { sql, count } from "drizzle-orm";
import { createDb } from "../db.js";
import { mediaAssets } from "@buildinternet/releases-core/schema";
import { authMiddleware } from "../middleware/auth.js";
import type { UploadResult } from "@releases/rendering/media";
import { respondError } from "../lib/error-response.js";
import { NotFoundError } from "@releases/lib/releases-error";

type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY: string;
    RELEASES_API_KEY?: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
  };
};

export const mediaRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Public: redirect to R2 custom domain, or serve directly as fallback
// ---------------------------------------------------------------------------

mediaRoutes.get("/media/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const mediaOrigin = c.env.MEDIA_ORIGIN;

  // Redirect to R2 custom domain when configured — avoids proxying through the Worker
  if (mediaOrigin) {
    return c.redirect(`${mediaOrigin}/${key}`, 301);
  }

  // Fallback: serve directly from R2 (no custom domain configured)
  const object = await c.env.MEDIA.get(key);
  if (!object) return respondError(c, new NotFoundError());

  const headers = new Headers();
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (object.httpMetadata?.contentType) {
    headers.set("content-type", object.httpMetadata.contentType);
  }
  if (object.httpMetadata?.contentEncoding) {
    headers.set("content-encoding", object.httpMetadata.contentEncoding);
  }
  if (object.httpMetadata?.contentDisposition) {
    headers.set("content-disposition", object.httpMetadata.contentDisposition);
  }
  if (object.httpMetadata?.contentLanguage) {
    headers.set("content-language", object.httpMetadata.contentLanguage);
  }

  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(object.body, { headers });
});

// ---------------------------------------------------------------------------
// Authenticated: upload media to R2
// ---------------------------------------------------------------------------

mediaRoutes.put("/media/:key{.+}", authMiddleware, async (c) => {
  const key = c.req.param("key");
  const body = await c.req.arrayBuffer();
  const contentType = c.req.header("content-type") ?? "application/octet-stream";

  await c.env.MEDIA.put(key, body, {
    httpMetadata: { contentType },
  });

  return c.json({ key }, 201);
});

// ---------------------------------------------------------------------------
// Authenticated: media asset registry
// ---------------------------------------------------------------------------

mediaRoutes.post("/media/assets", authMiddleware, async (c) => {
  const db = createDb(c.env.DB);
  const { assets } = await c.req.json<{
    assets: Array<UploadResult & { sourceId?: string | null; releaseId?: string | null }>;
  }>();

  // Deduplicate by r2Key — duplicate images in a single batch cause
  // UNIQUE constraint failures that ON CONFLICT DO NOTHING can't handle.
  const seen = new Set<string>();
  const deduped = assets.filter((a) => {
    if (seen.has(a.r2Key)) return false;
    seen.add(a.r2Key);
    return true;
  });

  let inserted = 0;
  const createdAt = new Date().toISOString();
  // D1 caps bound params at 100; 10 fields per row → batch 9 at a time.
  for (let i = 0; i < deduped.length; i += 9) {
    const chunk = deduped.slice(i, i + 9).map((a) => ({
      r2Key: a.r2Key,
      sourceUrl: a.sourceUrl,
      sourceFilename: a.sourceFilename ?? null,
      contentType: a.contentType,
      contentHash: a.contentHash,
      byteSize: a.byteSize,
      sourceId: a.sourceId ?? null,
      releaseId: a.releaseId ?? null,
      createdAt,
    }));
    // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert (100 bind param limit; 10 cols → 9 rows/batch)
    const rows = await db
      .insert(mediaAssets)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: mediaAssets.id });
    inserted += rows.length;
  }

  return c.json({ inserted });
});

mediaRoutes.get("/media/assets/stats", async (c) => {
  const db = createDb(c.env.DB);
  const [row] = await db
    .select({
      count: count(),
      totalBytes: sql<number>`COALESCE(SUM(${mediaAssets.byteSize}), 0)`,
    })
    .from(mediaAssets);

  return c.json({ count: row?.count ?? 0, totalBytes: row?.totalBytes ?? 0 });
});
