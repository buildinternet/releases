import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { eq } from "drizzle-orm";
import {
  ListingValidateBodySchema,
  ListingActivateBodySchema,
  errorEnvelopeSchema,
} from "@buildinternet/releases-api-types";
import { organizations } from "@buildinternet/releases-core/schema";
import { FLAGS, flag } from "@releases/lib/flags";
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { validateListing, normalizeListingDomain } from "../lib/listing/validate.js";
import { createStubFromManifest, resolveDomainOrg } from "../lib/well-known/stub.js";
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

listingRoutes.post(
  "/listing/activate",
  describeRoute({
    tags: ["Listing"],
    summary: "Activate an instant stub listing for an unlisted domain",
    description:
      "Re-validates https://{domain}/.well-known/releases.json server-side, then creates a stub org (basis: declared) for an unlisted domain. Already-stub domains take no write except an optional tracking-request stamp; tracked domains 409 with the org pointer. Public and anonymous; rate limited per IP and per domain.",
    responses: {
      201: { description: "Stub created (ListingActivateResult)" },
      200: { description: "Existing stub; tracking stamp updated (ListingActivateResult)" },
      409: {
        description: "Domain already listed (tracked)",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      400: {
        description: "Manifest invalid or unfetchable",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  validateJson(ListingActivateBodySchema),
  async (c) => {
    const guarded = await guardListing(c);
    if (guarded) return guarded;
    const { domain: rawDomain, requestTracking } = c.req.valid("json");
    const domain = normalizeListingDomain(rawDomain);
    if (!domain) return respondError(c, new ValidationError("Not a valid domain name."));

    const domainLimiter = c.env.LISTING_DOMAIN_RATE_LIMITER;
    if (domainLimiter) {
      const { success } = await domainLimiter.limit({ key: `listing-activate:${domain}` });
      if (!success) {
        return respondError(c, new RateLimitedError("Too many activations for this domain."));
      }
    }

    const db = createDb(c.env.DB);
    const webBaseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";
    const now = new Date().toISOString();

    const existing = await resolveDomainOrg(db, domain);
    if (existing) {
      if (existing.tier !== "stub") {
        return respondError(
          c,
          new ConflictError("This domain is already listed.", {
            details: { slug: existing.slug, webUrl: `${webBaseUrl}/${existing.slug}` },
          }),
        );
      }
      // Existing-stub carve-out: the only write is the tracking stamp.
      if (requestTracking) {
        await db
          .update(organizations)
          .set({ trackingRequestedAt: now, updatedAt: now })
          .where(eq(organizations.id, existing.id));
        logEvent("info", {
          component: "listing",
          event: "tracking-requested",
          orgId: existing.id,
          domain,
        });
      }
      return c.json(
        {
          activated: false,
          org: {
            slug: existing.slug,
            name: existing.name,
            status: "stub" as const,
            webUrl: `${webBaseUrl}/${existing.slug}`,
          },
          trackingRequested: requestTracking === true,
        },
        200,
      );
    }

    const result = await createStubFromManifest(db, domain, {});
    if (!result.created) {
      // Every skip here is a manifest/fetch problem (org_exists was handled
      // above; a create race lands org_exists too — treat it as conflict).
      if (result.skippedReason === "org_exists") {
        // A concurrent activation won the create race — re-resolve so this
        // 409 carries the same org pointer the pre-check 409 does.
        const winner = await resolveDomainOrg(db, domain);
        return respondError(
          c,
          new ConflictError(
            "This domain is already listed.",
            winner
              ? { details: { slug: winner.slug, webUrl: `${webBaseUrl}/${winner.slug}` } }
              : {},
          ),
        );
      }
      return respondError(
        c,
        new ValidationError("The manifest could not be activated.", {
          details: { reason: result.skippedReason },
        }),
      );
    }

    if (requestTracking) {
      await db
        .update(organizations)
        .set({ trackingRequestedAt: now, updatedAt: now })
        .where(eq(organizations.id, result.orgId!));
    }
    const [created] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.orgId!));
    logEvent("info", {
      component: "listing",
      event: "listing-activated",
      orgId: result.orgId,
      domain,
      trackingRequested: requestTracking === true,
      locationCount: result.locationCount,
    });
    return c.json(
      {
        activated: true,
        org: {
          slug: created!.slug,
          name: created!.name,
          status: "stub" as const,
          webUrl: `${webBaseUrl}/${created!.slug}`,
        },
        trackingRequested: requestTracking === true,
      },
      201,
    );
  },
);
