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

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: "invalid_parameter", message: "url must be a valid URL" }, 400);
  }

  if (parsed.protocol !== "https:") {
    return c.json({ error: "bad_request", message: "URL must use https" }, 400);
  }

  const result = await evaluateChangelog(url);
  return c.json(result);
});
