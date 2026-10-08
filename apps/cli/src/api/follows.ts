import type { Organization, Product } from "@buildinternet/releases-core/schema";
import type { LatestRelease } from "./types.js";
import type {
  Follow,
  FollowTarget,
  FollowsListResponse,
  FollowMutationResponse,
} from "@buildinternet/releases-api-types";
import { apiFetch, toLatestRelease } from "./core.js";
import type { LatestReleaseWire } from "./core.js";
import { findOrg } from "./orgs.js";
import { findProduct } from "./products.js";

// ── User follows + personalized feed (`/v1/me/*`) ──
//
// These act on the signed-in user's own account. `apiFetch` forwards the stored
// credential (a `relu_` user key from `releases login`, or `RELEASES_API_KEY`);
// the API's `/v1/me/*` gate accepts that Bearer user principal. Callers should
// check `isAuthenticated()` first so an unauthenticated user gets a "run
// `releases login`" hint instead of a raw 401.

/** A follow target resolved from a human identifier (slug / coordinate / id). */
export interface ResolvedFollowTarget {
  targetType: FollowTarget;
  targetId: string;
  /** Human label (name or slug) for confirmation messages. */
  label: string;
}

const orgFollowTarget = (o: Organization): ResolvedFollowTarget => ({
  targetType: "org",
  targetId: o.id,
  label: o.name ?? o.slug,
});
const productFollowTarget = (p: Product): ResolvedFollowTarget => ({
  targetType: "product",
  targetId: p.id,
  label: p.name ?? p.slug,
});

/**
 * Resolve a user-supplied identifier to a follow target. `org_…` / `prod_…` typed
 * ids and `org/slug` coordinates resolve unambiguously; a bare term is tried as
 * an org first (the common `releases follow vercel` case), then as a product.
 * Returns null when nothing resolves.
 */
export async function resolveFollowTarget(
  identifier: string,
): Promise<ResolvedFollowTarget | null> {
  const id = identifier.trim();
  if (id.startsWith("org_")) {
    const org = await findOrg(id);
    return org ? orgFollowTarget(org) : null;
  }
  if (id.startsWith("prod_") || id.includes("/")) {
    // Typed product id, or an `org/slug` coordinate → product.
    const product = await findProduct(id);
    return product ? productFollowTarget(product) : null;
  }
  // Bare term: prefer an org match, fall back to a product.
  const org = await findOrg(id);
  if (org) return orgFollowTarget(org);
  const product = await findProduct(id);
  return product ? productFollowTarget(product) : null;
}

/** List the signed-in user's follows, enriched + newest-first. */
export async function listMyFollows(): Promise<Follow[]> {
  const res = await apiFetch<FollowsListResponse | null>(`/v1/me/follows`);
  return res?.follows ?? [];
}

/** Add a follow (idempotent — re-following is a 200 no-op vs a 201 fresh add). */
export async function addFollow(
  targetType: FollowTarget,
  targetId: string,
): Promise<FollowMutationResponse> {
  return apiFetch<FollowMutationResponse>(`/v1/me/follows`, {
    method: "POST",
    body: JSON.stringify({ targetType, targetId }),
  });
}

/** Remove a follow (idempotent — removing a non-follow is a no-op). */
export async function removeFollow(
  targetType: FollowTarget,
  targetId: string,
): Promise<FollowMutationResponse> {
  return apiFetch<FollowMutationResponse>(
    `/v1/me/follows/${targetType}/${encodeURIComponent(targetId)}`,
    { method: "DELETE" },
  );
}

/**
 * The signed-in user's personalized release feed (org follow = its products
 * too). Same per-item wire shape as `/v1/releases/latest`, so it reuses
 * `toLatestRelease` and renders through the shared `renderReleaseRows` path that
 * `tail` uses. Page/offset paginated; returns `hasMore` from the list envelope.
 */
export async function getMyFeed(opts?: {
  page?: number;
  limit?: number;
}): Promise<{ releases: LatestRelease[]; hasMore: boolean }> {
  const qs = new URLSearchParams();
  if (opts?.page) qs.set("page", String(opts.page));
  if (opts?.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiFetch<{
    items: LatestReleaseWire[];
    pagination?: { hasMore?: boolean };
  } | null>(`/v1/me/feed${suffix}`);
  if (!data) throw new Error("Personalized feed unavailable (unexpected 404 on /v1/me/feed).");
  return {
    releases: data.items.map(toLatestRelease),
    hasMore: data.pagination?.hasMore ?? false,
  };
}
