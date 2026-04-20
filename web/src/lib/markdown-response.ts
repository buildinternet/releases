import { NextResponse } from "next/server";

const CACHE_POLICIES = {
  /** Static markdown files committed to git — aggressive edge caching. */
  static: "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
  /** Page backed by API data that updates when sources are edited. */
  "semi-static": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
  /** Page whose contents can change whenever a new release lands. */
  dynamic: "public, max-age=60, s-maxage=600, stale-while-revalidate=3600",
} as const;

type CachePolicy = keyof typeof CACHE_POLICIES;

export function markdownResponse(body: string, opts: { cache: CachePolicy }): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": CACHE_POLICIES[opts.cache],
    },
  });
}
