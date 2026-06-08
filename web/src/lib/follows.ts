/**
 * Browser client for the user follows surface (`/v1/me/follows`, `/v1/me/feed`
 * on the API worker). Uses `credentials: "include"` so the cross-subdomain
 * (`.releases.sh`) Better Auth session cookie rides along.
 */

import type {
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
