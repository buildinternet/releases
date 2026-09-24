/**
 * Admin view and revocation of an org's ownership claims (#2389). Lives on the
 * org routes rather than a new `/admin/*` family. Both routes check admin in
 * the handler: GET rides the public-read namespace and DELETE its `write`
 * gate, so neither is admin-only at the middleware layer. The owner's own
 * release is `DELETE /v1/listing/claims/:id` (routes/listing-claims.ts).
 */
import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { and, desc, eq } from "drizzle-orm";
import {
  ListOrgClaimsResponseSchema,
  RevokeOrgClaimBodySchema,
  AdminOrgClaimSchema,
  type AdminOrgClaim,
  type ListOrgClaimsResponse,
} from "@buildinternet/releases-api-types";
import { organizations, orgClaims, type OrgClaimRow } from "@buildinternet/releases-core/schema";
import { ForbiddenError, NotFoundError } from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { orgWhere } from "../utils.js";
import { isValidBearerAuth, resolveAuthIdentity } from "../middleware/auth.js";
import { respondError } from "../lib/error-response.js";
import { errorResponse } from "../lib/openapi-error.js";
import { validateJson } from "../lib/validate.js";
import { revokeClaim } from "./listing-claims.js";

function projectAdminClaim(row: OrgClaimRow): AdminOrgClaim {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    method: row.method,
    createdAt: row.createdAt,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revokeReason: row.revokeReason,
  };
}

/** Admin principal label stored in `revoked_by`: `root` or `token:<id>`. */
async function adminLabel(c: Context<Env>): Promise<string> {
  const identity = await resolveAuthIdentity(c);
  return identity?.kind === "token" ? `token:${identity.tokenId}` : "root";
}

export const orgClaimRoutes = new Hono<Env>();

orgClaimRoutes.get(
  "/orgs/:slug/claims",
  describeRoute({
    tags: ["Organizations"],
    summary: "List an org's ownership claims (admin)",
    description:
      "Admin scope required. Every claim on the org, any status, newest first. Never includes the proof token.",
    responses: {
      200: {
        description: "The org's claims",
        content: { "application/json": { schema: resolver(ListOrgClaimsResponseSchema) } },
      },
      403: errorResponse("Admin scope required"),
      404: errorResponse("Organization not found"),
    },
  }),
  async (c) => {
    if (!(await isValidBearerAuth(c))) {
      return respondError(c, new ForbiddenError("Admin scope is required to list claims"));
    }
    const db = createDb(c.env.DB);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(c.req.param("slug")));
    if (!org) return respondError(c, new NotFoundError("Organization not found"));

    const rows = await db
      .select()
      .from(orgClaims)
      .where(eq(orgClaims.orgId, org.id))
      .orderBy(desc(orgClaims.createdAt));
    c.header("Cache-Control", "private, no-store");
    const body: ListOrgClaimsResponse = { claims: rows.map(projectAdminClaim) };
    return c.json(body);
  },
);

orgClaimRoutes.delete(
  "/orgs/:slug/claims/:id",
  describeRoute({
    tags: ["Organizations"],
    summary: "Revoke an ownership claim (admin)",
    description:
      "Admin scope required, with a `reason`. Ends a pending or verified claim; the row is kept as `revoked` with who and why. Publish tokens that relied on it stop working on their next request. Idempotent; an already-ended claim is returned unchanged.",
    responses: {
      200: {
        description: "The ended claim",
        content: { "application/json": { schema: resolver(AdminOrgClaimSchema) } },
      },
      400: errorResponse("Missing reason"),
      403: errorResponse("Admin scope required"),
      404: errorResponse("Organization or claim not found"),
    },
  }),
  validateJson(RevokeOrgClaimBodySchema),
  async (c) => {
    if (!(await isValidBearerAuth(c))) {
      return respondError(c, new ForbiddenError("Admin scope is required to revoke a claim"));
    }
    const { reason } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(c.req.param("slug")));
    if (!org) return respondError(c, new NotFoundError("Organization not found"));
    const [claim] = await db
      .select()
      .from(orgClaims)
      .where(and(eq(orgClaims.id, c.req.param("id")), eq(orgClaims.orgId, org.id)))
      .limit(1);
    if (!claim) return respondError(c, new NotFoundError("Claim not found"));

    const by = await adminLabel(c);
    const ended = await revokeClaim(db, claim, { by, reason });
    if (ended !== claim) {
      logEvent("info", {
        component: "listing",
        event: "claim-revoked",
        claimId: claim.id,
        orgId: org.id,
        userId: claim.userId,
        by,
        reason,
        previousStatus: claim.status,
      });
    }
    return c.json(projectAdminClaim(ended));
  },
);
