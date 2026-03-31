import { Hono } from "hono";
import { sql, count } from "drizzle-orm";
import { createDb } from "../db.js";
import { mediaAssets } from "../../../../src/db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { UploadResult } from "../../../../src/lib/media.js";

type Env = {
  Bindings: {
    DB: D1Database;
    RELEASED_API_KEY: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
    MEDIA_ORIGIN?: string;
  };
};

export const mediaRoutes = new Hono<Env>();

// Raster image types eligible for Cloudflare Image Transforms (no SVG — it's vector)
const RASTER_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
]);

// ---------------------------------------------------------------------------
// Public: serve media from R2 with optional Cloudflare Image Transforms
// ---------------------------------------------------------------------------

mediaRoutes.get("/media/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const mediaOrigin = c.env.MEDIA_ORIGIN;

  // Use head() to check existence and content-type without downloading the body
  const meta = await c.env.MEDIA.head(key);
  if (!meta) {
    return c.json({ error: "not_found" }, 404);
  }

  const contentType = meta.httpMetadata?.contentType ?? "";

  // If we have a MEDIA_ORIGIN (R2 custom domain) and this is a raster image,
  // use Cloudflare Image Transformations for automatic resize + format negotiation.
  if (mediaOrigin && RASTER_IMAGE_TYPES.has(contentType)) {
    return fetch(`${mediaOrigin}/${key}`, {
      headers: { Accept: c.req.header("Accept") ?? "image/*" },
      cf: { image: { width: 1200, fit: "scale-down", quality: 80, format: "auto" } },
    } as unknown as RequestInit);
  }

  // Serve directly from R2
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.json({ error: "not_found" }, 404);

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

  let inserted = 0;
  // D1 has a ~1MB query size limit; 25 is safe for small media_asset rows.
  // Release inserts use 5 because content fields are much larger.
  for (let i = 0; i < assets.length; i += 25) {
    const chunk = assets.slice(i, i + 25).map((a) => ({
      r2Key: a.r2Key,
      sourceUrl: a.sourceUrl,
      sourceFilename: a.sourceFilename ?? null,
      contentType: a.contentType,
      contentHash: a.contentHash,
      byteSize: a.byteSize,
      sourceId: a.sourceId ?? null,
      releaseId: a.releaseId ?? null,
    }));
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
