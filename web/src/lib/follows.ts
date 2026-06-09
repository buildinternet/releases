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

function apiBase(): string {
  const url = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!url) throw new Error("NEXT_PUBLIC_BETTER_AUTH_URL is not set");
  return url.replace(/\/$/, "");
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

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
  if (!res.ok) return null;
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
