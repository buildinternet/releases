import { Hono } from "hono";
import { and, isNotNull, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { releases } from "../../../../src/db/schema.js";

type Env = {
  Bindings: {
    DB: D1Database;
    API_SECRET: string;
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
