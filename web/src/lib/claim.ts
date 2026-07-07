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
  ListingPromoteResult,
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

/**
 * Shared fetch + JSON-decode wrapper for the claim lane. Wraps `fetch()`
 * itself in a try/catch so a transport failure (offline, DNS, CORS) surfaces
 * as the same friendly Error copy as a non-2xx API response, instead of
 * bubbling the raw TypeError from `fetch`.
 */
async function requestClaimJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Could not reach the server. Please check your connection and try again.");
  }
  if (!res.ok) {
    throw new Error(await readClaimErrorMessage(res, fallback));
  }
  return (await res.json()) as T;
}

export async function startClaim(domain: string): Promise<OrgClaim> {
  return requestClaimJson<OrgClaim>(
    `${apiBase()}/v1/listing/claim`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    },
    "Could not start a claim. Please try again.",
  );
}

export async function verifyClaim(claimId: string): Promise<ClaimVerifyResult> {
  return requestClaimJson<ClaimVerifyResult>(
    `${apiBase()}/v1/listing/claim/verify`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId }),
    },
    "Could not check the claim. Please try again.",
  );
}

export async function listClaims(): Promise<OrgClaim[]> {
  const data = await requestClaimJson<ListingClaimsResult>(
    `${apiBase()}/v1/listing/claims`,
    { credentials: "include" },
    "Could not load your claims.",
  );
  return data.claims;
}

/**
 * Self-serve Tier-1 promotion (#1947 PR B). Requires a verified claim on the
 * domain — the API 403s otherwise — and 404s when the promotion kill switch
 * is off (distinct from the listing-lane switch).
 */
export async function promoteListing(domain: string): Promise<ListingPromoteResult> {
  const res = await fetch(`${apiBase()}/v1/listing/promote`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  if (!res.ok) {
    throw new Error(
      await readClaimErrorMessage(res, "Could not enable tracking. Please try again."),
    );
  }
  return (await res.json()) as ListingPromoteResult;
}
