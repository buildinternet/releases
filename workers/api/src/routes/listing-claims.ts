import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { and, eq, inArray } from "drizzle-orm";
import {
  ListingClaimBodySchema,
  ListingClaimVerifyBodySchema,
  errorEnvelopeSchema,
  type OrgClaim,
} from "@buildinternet/releases-api-types";
import { organizations, orgClaims, type OrgClaimRow } from "@buildinternet/releases-core/schema";
import { newOrgClaimId, newClaimTokenId } from "@buildinternet/releases-core/id";
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import { attachFollowsSession } from "../middleware/auth.js";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { normalizeListingDomain } from "../lib/listing/validate.js";
import { resolveDomainOrg } from "../lib/well-known/stub.js";
import { verifyDomainControl } from "../lib/listing/claim-verify.js";
import { respondError } from "../lib/error-response.js";
import { validateJson } from "../lib/validate.js";
import { requireListingEnabled } from "./listing.js";

const CLAIM_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

type Db = ReturnType<typeof createDb>;

function requireSession(c: Context<Env>): { user: { id: string } } | null {
  const session = c.get("session");
  return session ?? null;
}

function claimInstructions(domain: string): { wellKnownUrl: string; dnsRecordName: string } {
  return {
    wellKnownUrl: `https://${domain}/.well-known/releases-verify.txt`,
    dnsRecordName: `_releases-challenge.${domain}`,
  };
}

/** Project a DB claim row + its org into the public `OrgClaim` wire shape.
 *  `token`/`instructions` only ride along while the claim is `pending` — once
 *  verified or expired there is nothing left to prove (or the token is stale). */
function projectClaim(
  claim: OrgClaimRow,
  org: { slug: string; name: string; domain: string | null },
  webBaseUrl: string,
): OrgClaim {
  const domain = org.domain ?? "";
  const base: OrgClaim = {
    id: claim.id,
    org: { slug: org.slug, name: org.name, webUrl: `${webBaseUrl}/${org.slug}` },
    status: claim.status as OrgClaim["status"],
    createdAt: claim.createdAt,
    expiresAt: claim.expiresAt,
  };
  if (claim.method) base.method = claim.method as OrgClaim["method"];
  if (claim.verifiedAt) base.verifiedAt = claim.verifiedAt;
  if (claim.status === "pending") {
    base.token = claim.token;
    base.instructions = claimInstructions(domain);
  }
  return base;
}

/** Flip any of the caller's overdue-pending claims to `expired` in place. */
async function expireOverdueClaims(db: Db, rows: OrgClaimRow[]): Promise<OrgClaimRow[]> {
  const now = new Date().toISOString();
  const overdue = rows.filter((r) => r.status === "pending" && r.expiresAt < now);
  if (overdue.length === 0) return rows;
  await Promise.all(
    overdue.map((r) =>
      db.update(orgClaims).set({ status: "expired" }).where(eq(orgClaims.id, r.id)),
    ),
  );
  const overdueIds = new Set(overdue.map((r) => r.id));
  return rows.map((r) => (overdueIds.has(r.id) ? { ...r, status: "expired" as const } : r));
}

/**
 * No-auth-middleware handlers so unit tests can mount them behind an injected
 * session (mirrors `meHandlers`). Production composes them under
 * `listingClaimRoutes` below, which stays anonymous at the Hono-middleware
 * layer (matching validate/activate) and soft-resolves the session via
 * {@link attachFollowsSession} — each handler is responsible for its own
 * 401 via `c.get("session")`.
 */
export const listingClaimHandlers = new Hono<Env>();

listingClaimHandlers.post(
  "/listing/claim",
  describeRoute({
    tags: ["Listing"],
    summary: "Start (or fetch) an ownership claim on a listed domain",
    description:
      "Signed-in only. Mints a pending claim with a well-known-token + DNS-TXT proof pair for a stub or tracked domain; idempotent once verified. 404s an unlisted domain.",
    responses: {
      201: { description: "Pending claim minted (OrgClaim)" },
      200: { description: "Existing verified claim returned as-is (OrgClaim)" },
      401: {
        description: "Sign-in required",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      404: {
        description: "Lane disabled, or the domain is not listed",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  requireListingEnabled,
  validateJson(ListingClaimBodySchema),
  async (c) => {
    const session = requireSession(c);
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

    const { domain: rawDomain } = c.req.valid("json");
    const domain = normalizeListingDomain(rawDomain);
    if (!domain) return respondError(c, new ValidationError("Not a valid domain name."));

    const db = createDb(c.env.DB);
    const webBaseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";
    const org = await resolveDomainOrg(db, domain);
    if (!org) {
      return respondError(
        c,
        new NotFoundError("This domain isn't listed yet — activate a listing first."),
      );
    }

    const [existingVerified] = await db
      .select()
      .from(orgClaims)
      .where(
        and(
          eq(orgClaims.orgId, org.id),
          eq(orgClaims.userId, session.user.id),
          eq(orgClaims.status, "verified"),
        ),
      )
      .limit(1);
    if (existingVerified) {
      return c.json(projectClaim(existingVerified, org, webBaseUrl), 200);
    }

    const now = new Date();
    const row: typeof orgClaims.$inferInsert = {
      id: newOrgClaimId(),
      orgId: org.id,
      userId: session.user.id,
      token: newClaimTokenId(),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CLAIM_EXPIRY_MS).toISOString(),
    };
    await db.insert(orgClaims).values(row);
    logEvent("info", {
      component: "listing",
      event: "claim-created",
      orgId: org.id,
      userId: session.user.id,
      domain,
    });
    return c.json(projectClaim(row as OrgClaimRow, org, webBaseUrl), 201);
  },
);

listingClaimHandlers.post(
  "/listing/claim/verify",
  describeRoute({
    tags: ["Listing"],
    summary: "Check the proof for a pending ownership claim",
    description:
      "Signed-in only, and the claim must belong to the caller (404 otherwise — no existence oracle). Checks the well-known token file and the DNS TXT record; either passes. Fails closed on any ambiguous response. 200 whether or not it verifies.",
    responses: {
      200: { description: "ClaimVerifyResult (verified may be true or false)" },
      401: {
        description: "Sign-in required",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      404: {
        description: "No such claim for this caller",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      409: {
        description: "Claim expired",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  requireListingEnabled,
  validateJson(ListingClaimVerifyBodySchema),
  async (c) => {
    const session = requireSession(c);
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

    const { claimId } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const webBaseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";

    const [claim] = await db
      .select()
      .from(orgClaims)
      .where(and(eq(orgClaims.id, claimId), eq(orgClaims.userId, session.user.id)))
      .limit(1);
    if (!claim) return respondError(c, new NotFoundError("No such claim."));

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, claim.orgId))
      .limit(1);
    if (!org) return respondError(c, new NotFoundError("No such claim."));

    if (claim.status === "verified") {
      return c.json(
        {
          verified: true,
          checked: {
            wellKnown: claim.method === "well-known" ? "ok" : "mismatch",
            dnsTxt: claim.method === "dns-txt" ? "ok" : "mismatch",
          },
          claim: projectClaim(claim, org, webBaseUrl),
        },
        200,
      );
    }

    const now = new Date().toISOString();
    if (claim.expiresAt < now) {
      await db.update(orgClaims).set({ status: "expired" }).where(eq(orgClaims.id, claim.id));
      return respondError(
        c,
        new ConflictError("This claim has expired; start a new claim.", {
          details: { claimId: claim.id },
        }),
      );
    }

    const domainLimiter = c.env.LISTING_DOMAIN_RATE_LIMITER;
    if (domainLimiter) {
      const { success } = await domainLimiter.limit({ key: `claim-verify:${org.domain ?? ""}` });
      if (!success) {
        return respondError(c, new RateLimitedError("Too many verification attempts."));
      }
    }

    const result = await verifyDomainControl(org.domain ?? "", claim.token);
    if (result.verified) {
      await db
        .update(orgClaims)
        .set({ status: "verified", verifiedAt: now, method: result.method })
        .where(eq(orgClaims.id, claim.id));
      await db
        .update(organizations)
        .set({ trackingRequestedAt: now, updatedAt: now })
        .where(eq(organizations.id, org.id));
      logEvent("info", {
        component: "listing",
        event: "claim-verified",
        orgId: org.id,
        userId: session.user.id,
        method: result.method,
      });
    } else {
      logEvent("info", {
        component: "listing",
        event: "claim-verify-failed",
        orgId: org.id,
        userId: session.user.id,
        checked: result.checked,
      });
    }

    const [updated] = await db.select().from(orgClaims).where(eq(orgClaims.id, claim.id)).limit(1);
    return c.json(
      {
        verified: result.verified,
        checked: result.checked,
        claim: projectClaim(updated ?? claim, org, webBaseUrl),
      },
      200,
    );
  },
);

listingClaimHandlers.get(
  "/listing/claims",
  describeRoute({
    tags: ["Listing"],
    summary: "List the caller's own ownership claims",
    description:
      "Signed-in only. Lazily flips overdue pending claims to expired on read. Pending claims include the token + proof instructions; verified/expired do not.",
    responses: {
      200: { description: "ListingClaimsResult" },
      401: {
        description: "Sign-in required",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
      404: { description: "Lane disabled" },
    },
  }),
  requireListingEnabled,
  async (c) => {
    const session = requireSession(c);
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

    const db = createDb(c.env.DB);
    const webBaseUrl = c.env.WEB_BASE_URL ?? "https://releases.sh";

    const rows = await db.select().from(orgClaims).where(eq(orgClaims.userId, session.user.id));
    const freshened = await expireOverdueClaims(db, rows);

    const orgIds = [...new Set(freshened.map((r) => r.orgId))];
    const orgRows = orgIds.length
      ? await db.select().from(organizations).where(inArray(organizations.id, orgIds))
      : [];
    const orgById = new Map(orgRows.map((o) => [o.id, o]));

    const claims = freshened
      .map((row) => {
        const org = orgById.get(row.orgId);
        return org ? projectClaim(row, org, webBaseUrl) : null;
      })
      .filter((claim): claim is OrgClaim => claim !== null);
    return c.json({ claims });
  },
);

/**
 * Production composition: flag+IP-limiter guard (per route) + soft session
 * attach, then the handlers. The namespace itself stays reachable
 * anonymously — every handler above gates on `c.get("session")` itself, so
 * flag-off 404s and rate limits fire before any 401.
 */
export const listingClaimRoutes = new Hono<Env>();
listingClaimRoutes.use("/listing/claim*", attachFollowsSession);
listingClaimRoutes.use("/listing/claims", attachFollowsSession);
listingClaimRoutes.route("/", listingClaimHandlers);
