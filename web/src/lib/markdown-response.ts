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

interface MarkdownResponseOptions {
  cache: CachePolicy;
  /**
   * Absolute URL of the HTML page this markdown is an alternate representation
   * of. Emitted as an HTTP `Link: rel="canonical"` header so Google consolidates
   * ranking signals onto the page and the `.md` twin isn't flagged as a
   * duplicate — while staying crawlable and fetchable for agents (unlike
   * `noindex`, which would pull it from AI-answer surfaces too). Markdown can't
   * carry an HTML `<link rel=canonical>`, so the header is the only mechanism.
   */
  canonical?: string;
  /**
   * Set when the markdown has no canonical HTML twin to point at (e.g. the
   * `/release/:id` adapter, which has no standalone page). Emits
   * `X-Robots-Tag: noindex` instead, matching the `.json`/`.atom` treatment.
   */
  noindex?: boolean;
}

export function markdownResponse(body: string, opts: MarkdownResponseOptions): NextResponse {
  const headers: Record<string, string> = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": CACHE_POLICIES[opts.cache],
  };
  if (opts.canonical) headers.Link = `<${opts.canonical}>; rel="canonical"`;
  if (opts.noindex) headers["X-Robots-Tag"] = "noindex";
  return new NextResponse(body, { headers });
}
