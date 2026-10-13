import type { MetadataRoute } from "next";
import { getStaticBaseUrl } from "@/lib/base-url";

const BASE_URL = getStaticBaseUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/.well-known/http-message-signatures-directory"],
      // /release/ is blocked outright: the pages are noindexed stubs of
      // upstream content (see release/[id]/page.tsx), and blocking them keeps
      // crawlers from spending requests re-fetching tens of thousands of
      // pages that will never be indexed. Feed surfaces link release titles
      // upstream rather than here. The meta noindex stays as
      // belt-and-suspenders for any crawler that ignores robots.txt.
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
