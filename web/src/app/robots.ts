import type { MetadataRoute } from "next";
import { getStaticBaseUrl } from "@/lib/base-url";

const BASE_URL = getStaticBaseUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/.well-known/http-message-signatures-directory"],
      disallow: ["/api/", "/.well-known/"],
    },
    // One curated sitemap of durable landing pages. /release/* pages are
    // noindexed stubs of upstream content (see release/[id]/page.tsx) — they
    // stay crawlable (no Disallow) so the noindex directive is actually seen,
    // but are never sitemapped.
    sitemap: [`${BASE_URL}/sitemap.xml`],
  };
}
