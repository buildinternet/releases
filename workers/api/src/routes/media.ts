import { Hono } from "hono";

type Env = {
  Bindings: {
    DB: D1Database;
    API_SECRET: string;
    STATUS_HUB: DurableObjectNamespace;
    MEDIA: R2Bucket;
  };
};

export const mediaRoutes = new Hono<Env>();

// GET /media/:key — public media serving
mediaRoutes.get("/media/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.MEDIA.get(key);

  if (!object) {
    return c.json({ error: "not_found" }, 404);
  }

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

// PUT /media/:key — authenticated upload for CLI
mediaRoutes.put("/media/:key{.+}", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || authHeader !== `Bearer ${c.env.API_SECRET}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const key = c.req.param("key");
  const body = await c.req.arrayBuffer();
  const contentType = c.req.header("content-type") ?? "application/octet-stream";

  await c.env.MEDIA.put(key, body, {
    httpMetadata: { contentType },
  });

  return c.json({ key }, 201);
});
