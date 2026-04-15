import type { MetadataRoute } from "next";

const BASE_URL = process.env.RELEASED_BASE_URL?.replace(/\/$/, "") ?? "https://releases.sh";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/.well-known/"],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
