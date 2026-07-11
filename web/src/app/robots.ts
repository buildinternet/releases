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
    sitemap: [`${BASE_URL}/sitemap.xml`, `${BASE_URL}/sitemap-releases.xml`],
  };
}
