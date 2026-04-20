import { Hono } from "hono";
import { evaluateChangelog } from "@releases/ai-internal/evaluate";
import type { Env } from "../index.js";

export const evaluateRoutes = new Hono<Env>();

/**
 * GET /evaluate?url=<url>
 *
 * Runs pre-checks on a URL (provider detection, feed discovery, markdown
 * suffix probing) and returns a structured recommendation for ingestion.
 */
evaluateRoutes.get("/evaluate", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.json({ error: "missing_parameter", message: "url query parameter is required" }, 400);
  }

  try {
    // oxlint-disable-next-line no-new -- URL constructor is the standard way to validate URLs
    new URL(url);
  } catch {
    return c.json({ error: "invalid_parameter", message: "url must be a valid URL" }, 400);
  }

  const result = await evaluateChangelog(url);
  return c.json(result);
});
