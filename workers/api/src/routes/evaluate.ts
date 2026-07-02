import { Hono } from "hono";
import { evaluateChangelog } from "@releases/ai-internal/evaluate";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError } from "@releases/lib/releases-error";

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
    return respondError(
      c,
      new ValidationError("url query parameter is required", { code: "bad_request" }),
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return respondError(c, new ValidationError("url must be a valid URL", { code: "bad_request" }));
  }

  if (parsed.protocol !== "https:") {
    return respondError(c, new ValidationError("URL must use https", { code: "bad_request" }));
  }

  const result = await evaluateChangelog(url);
  return c.json(result);
});
