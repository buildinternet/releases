/**
 * Browser client for the user follows surface (`/v1/me/follows`, `/v1/me/feed`
 * on the API worker). Uses `credentials: "include"` so the cross-subdomain
 * (`.releases.sh`) Better Auth session cookie rides along.
 */

import type {
  DigestCadence,
  DigestPrefsResponse,
  FeedToken,
  FeedTokenResponse,
  Follow,
  FollowTarget,
  FollowsListResponse,
  PersonalizedFeedResponse,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

/** Must match GET /v1/me/feed default page size (workers/api feed-cache). */
export const FEED_PAGE_SIZE = 30;

export async function listFollows(): Promise<Follow[]> {
  const res = await fetch(`${apiBase()}/v1/me/follows`, { credentials: "include" });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load follows (${res.status})`));
  return ((await res.json()) as FollowsListResponse).follows;
}

export async function follow(targetType: FollowTarget, targetId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/follows`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetType, targetId }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to follow (${res.status})`));
}

export async function unfollow(targetType: FollowTarget, targetId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/follows/${targetType}/${targetId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to unfollow (${res.status})`));
}

export async function getFeed(
  cursor?: string | null,
  limit = FEED_PAGE_SIZE,
): Promise<PersonalizedFeedResponse> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetch(`${apiBase()}/v1/me/feed?${qs}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load feed (${res.status})`));
  return (await res.json()) as PersonalizedFeedResponse;
}

// ── Feed token (/v1/me/feed/token) ──────────────────────────────────────────

export async function getFeedToken(): Promise<FeedToken | null> {
  const res = await fetch(`${apiBase()}/v1/me/feed/token`, { credentials: "include" });
  // The endpoint returns 200 `{ token: null }` when the user has no token — that
  // is the only `null` path. Any non-OK status is a real failure (auth/5xx), so
  // throw (consistent with the sibling helpers) rather than masking it as "no token".
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load feed URL (${res.status})`));
  return ((await res.json()) as FeedTokenResponse).token;
}

export async function mintFeedToken(): Promise<FeedToken> {
  const res = await fetch(`${apiBase()}/v1/me/feed/token`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to generate feed URL (${res.status})`));
  return (await res.json()) as FeedToken;
}

export async function revokeFeedToken(): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/feed/token`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to revoke feed URL (${res.status})`));
}

// ── Digest preferences (/v1/me/digest) ──────────────────────────────────────

export async function getDigestCadence(): Promise<DigestCadence> {
  const res = await fetch(`${apiBase()}/v1/me/digest`, { credentials: "include" });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to load digest setting (${res.status})`));
  return ((await res.json()) as DigestPrefsResponse).cadence;
}

export async function setDigestCadence(cadence: DigestCadence): Promise<DigestCadence> {
  const res = await fetch(`${apiBase()}/v1/me/digest`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cadence }),
  });
  if (!res.ok)
    throw new Error(await errorMessage(res, `Failed to update digest setting (${res.status})`));
  return ((await res.json()) as DigestPrefsResponse).cadence;
}
