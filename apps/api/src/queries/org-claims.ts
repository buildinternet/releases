/**
 * Ending ownership claims (#2389). Shared by the owner route
 * (`DELETE /v1/listing/claims/:id`) and the admin route
 * (`DELETE /v1/orgs/:slug/claims/:id`).
 */
import { and, eq } from "drizzle-orm";
import { orgClaims, type OrgClaimRow } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import type { D1Db } from "../db.js";

/**
 * A claim that can still be verified or ended. `revoked` and `expired` are
 * terminal: verify refuses them and the owner starts a fresh claim instead.
 */
export function isClaimLive(status: OrgClaimRow["status"]): boolean {
  return status === "pending" || status === "verified";
}

/**
 * End a live claim, keeping the row as `revoked` with who and why, and log it.
 * A terminal claim is returned as-is (idempotent). The update is guarded on the
 * status it read, so a racing verify is never overwritten; losing that race
 * also returns the claim unchanged.
 */
export async function revokeClaim(
  db: D1Db,
  claim: OrgClaimRow,
  { by, reason }: { by: string; reason: string },
): Promise<OrgClaimRow> {
  if (!isClaimLive(claim.status)) return claim;
  const [ended] = await db
    .update(orgClaims)
    .set({
      status: "revoked",
      revokedAt: new Date().toISOString(),
      revokedBy: by,
      revokeReason: reason,
    })
    .where(and(eq(orgClaims.id, claim.id), eq(orgClaims.status, claim.status)))
    .returning();
  if (!ended) return claim;
  logEvent("info", {
    component: "listing",
    event: "claim-revoked",
    claimId: claim.id,
    orgId: claim.orgId,
    userId: claim.userId,
    by,
    reason,
    previousStatus: claim.status,
  });
  return ended;
}
