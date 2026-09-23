import type { MetadataRoute } from "next";
import { getStaticBaseUrl } from "@/lib/base-url";

const BASE_URL = getStaticBaseUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/.well-known/http-message-signatures-directory"],
      // /release/ is blocked outright: the pages are noindexed stubs of
      // upstream content (see release/[id]/page.tsx) and GSC (2026-08-12)
      // showed Google had already deindexed virtually all of them (~11.4K
      // crawled-not-indexed vs 373 indexed pages SITEWIDE) while still
      // burning crawl budget re-fetching them. The usual "stay crawlable so
      // the noindex is seen" sequencing is moot when there's nothing left to
      // drain; the meta noindex stays as belt-and-suspenders for any
      // non-robots.txt-respecting crawler.
      disallow: ["/api/", "/.well-known/", "/release/"],
    },
    // Curated sitemaps of durable landing pages, split by page class so GSC
    // reports index coverage per file (static/editorial core, registry
    // surface, collections). /release/* is never sitemapped.
    sitemap: [
      `${BASE_URL}/sitemap.xml`,
      `${BASE_URL}/sitemap-orgs.xml`,
      `${BASE_URL}/sitemap-collections.xml`,
    ],
  };
}
