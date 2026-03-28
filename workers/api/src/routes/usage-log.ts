import { Hono } from "hono";
import { createDb } from "../db.js";
import { usageLog } from "../../../../src/db/schema.js";
import type { Env } from "../index.js";

export const usageLogRoutes = new Hono<Env>();

usageLogRoutes.post("/usage-log", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  const [inserted] = await db.insert(usageLog).values({
    operation: body.operation,
    model: body.model,
    inputTokens: body.inputTokens,
    outputTokens: body.outputTokens,
    sourceSlug: body.sourceSlug ?? null,
    releaseCount: body.releaseCount ?? null,
  }).returning();

  return c.json(inserted, 201);
});
