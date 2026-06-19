import "server-only";
import { cookies } from "next/headers";
import type { PersonalizedFeedResponse } from "@buildinternet/releases-api-types";
import { webApiHeaders } from "@/lib/api";
import { FEED_PAGE_SIZE } from "@/lib/follows";

/** Server-side prefetch of the following page's first feed page. */
export async function fetchFollowingFeed(): Promise<PersonalizedFeedResponse | null> {
  const base = process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.replace(/\/$/, "");
  if (!base) return null;

  const cookie = (await cookies()).toString();
  if (!cookie) return null;

  try {
    const res = await fetch(`${base}/v1/me/feed?page=1&limit=${FEED_PAGE_SIZE}`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? ((await res.json()) as PersonalizedFeedResponse) : null;
  } catch {
    return null;
  }
}
