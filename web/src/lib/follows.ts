/**
 * Browser client for the user follows surface (`/v1/me/follows`, `/v1/me/feed`
 * on the API worker). Uses `credentials: "include"` so the cross-subdomain
 * (`.releases.sh`) Better Auth session cookie rides along.
 */

import type {
  FeedToken,
  FeedTokenResponse,
  Follow,
  FollowTarget,
  FollowsListResponse,
  PersonalizedFeedResponse,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";

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

export async function getFeed(page = 1, limit = 30): Promise<PersonalizedFeedResponse> {
  const res = await fetch(`${apiBase()}/v1/me/feed?page=${page}&limit=${limit}`, {
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
