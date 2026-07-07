/**
 * Browser client for the self-serve ownership-claim lane (`/v1/listing/claim*`
 * on the API worker, #1947). Signed-in only — `credentials: "include"` rides
 * the cross-subdomain (`.releases.sh`) Better Auth session cookie, same as
 * `api-keys.ts`. Unlike `api-keys.ts`, these routes throw `ReleasesError`
 * subclasses via `respondError`, so errors arrive as the nested envelope
 * (`{ error: { message } }`), matching the decoding used by the `/submit`
 * fast lane (`listing-fast-lane.tsx`) rather than `user-api.ts`'s flat
 * `errorMessage()` helper.
 */

import type {
  OrgClaim,
  ClaimVerifyResult,
  ListingClaimsResult,
} from "@buildinternet/releases-api-types";
import { apiBase } from "./user-api";

async function readClaimErrorMessage(res: Response, fallback: string): Promise<string> {
  if (res.status === 429) return "Too many attempts. Please try again in a minute.";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message || fallback;
  } catch {
    return fallback;
  }
}

export async function startClaim(domain: string): Promise<OrgClaim> {
  const res = await fetch(`${apiBase()}/v1/listing/claim`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  if (!res.ok) {
    throw new Error(await readClaimErrorMessage(res, "Could not start a claim. Please try again."));
  }
  return (await res.json()) as OrgClaim;
}

export async function verifyClaim(claimId: string): Promise<ClaimVerifyResult> {
  const res = await fetch(`${apiBase()}/v1/listing/claim/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimId }),
  });
  if (!res.ok) {
    throw new Error(
      await readClaimErrorMessage(res, "Could not check the claim. Please try again."),
    );
  }
  return (await res.json()) as ClaimVerifyResult;
}

export async function listClaims(): Promise<OrgClaim[]> {
  const res = await fetch(`${apiBase()}/v1/listing/claims`, { credentials: "include" });
  if (!res.ok) {
    throw new Error(await readClaimErrorMessage(res, "Could not load your claims."));
  }
  const data = (await res.json()) as ListingClaimsResult;
  return data.claims;
}
