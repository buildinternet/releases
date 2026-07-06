import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { ListingValidateBodySchema, errorEnvelopeSchema } from "@buildinternet/releases-api-types";
import { FLAGS, flag } from "@releases/lib/flags";
import { NotFoundError, RateLimitedError } from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { validateListing } from "../lib/listing/validate.js";
import { respondError } from "../lib/error-response.js";
import { validateJson } from "../lib/validate.js";

export const listingRoutes = new Hono<Env>();

/**
 * Self-serve listing lane (#1947 phase 2). Both routes are PUBLIC and
 * anonymous — integrity comes from manifest host-scoping (you can only
 * declare a domain you control), the kill switch, and the rate limiters.
 */
async function guardListing(c: Context<Env>): Promise<Response | null> {
  const enabled = await flag(
    c.env.FLAGS,
    c.env.LISTING_SELF_SERVE_ENABLED,
    FLAGS.listingSelfServeEnabled,
  );
  if (!enabled) {
    // 404 (not 403): when the lane is off it simply doesn't exist.
    return respondError(c, new NotFoundError("Not found"));
  }
  const limiter = c.env.LISTING_RATE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `listing:${ip}` });
    if (!success) {
      return respondError(c, new RateLimitedError("Too many listing requests; slow down."));
    }
  }
  return null;
}

listingRoutes.post(
  "/listing/validate",
  describeRoute({
    tags: ["Listing"],
    summary: "Validate a domain's releases.json and preview its listing",
    description:
      "Fetches https://{domain}/.well-known/releases.json live (HTTPS-only, 64KB, 5s), validates it against the v2 manifest schema, and returns a preview: identity, products, and per-locator classification, plus whether the domain is already listed. Public and anonymous; rate limited.",
    responses: {
      200: { description: "ListingValidationResult" },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  validateJson(ListingValidateBodySchema),
  async (c) => {
    const guarded = await guardListing(c);
    if (guarded) return guarded;
    const { domain } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const result = await validateListing(db, domain, {
      webBaseUrl: c.env.WEB_BASE_URL ?? "https://releases.sh",
    });
    logEvent("info", {
      component: "listing",
      event: "listing-validated",
      domain,
      valid: result.valid,
      domainStatus: result.domainStatus,
    });
    return c.json(result);
  },
);
