import type { MetadataRoute } from "next";
import { api, ApiSetupError } from "@/lib/api";

export const revalidate = 3600;

const BASE_URL = process.env.RELEASED_BASE_URL?.replace(/\/$/, "") ?? "https://releases.sh";

const STATIC_ROUTES: Array<{ path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }> = [
  { path: "/", changeFrequency: "hourly", priority: 1.0 },
  { path: "/search", changeFrequency: "weekly", priority: 0.5 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
  { path: "/docs/installation", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/api/mcp", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/api/rest", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/admin", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/analysis", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/browsing", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/fetching", changeFrequency: "monthly", priority: 0.6 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: `${BASE_URL}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  let dynamicEntries: MetadataRoute.Sitemap = [];

  try {
    const orgs = await api.orgs();

    const orgEntries: MetadataRoute.Sitemap = orgs.map((org) => ({
      url: `${BASE_URL}/${org.slug}`,
      lastModified: org.lastActivity ? new Date(org.lastActivity) : now,
      changeFrequency: "daily",
      priority: 0.8,
    }));

    const detailResults = await Promise.allSettled(orgs.map((org) => api.orgDetail(org.slug)));

    const sourceEntries: MetadataRoute.Sitemap = [];
    const productEntries: MetadataRoute.Sitemap = [];

    for (const result of detailResults) {
      if (result.status !== "fulfilled") continue;
      const detail = result.value;

      for (const source of detail.sources) {
        if (source.isHidden) continue;
        sourceEntries.push({
          url: `${BASE_URL}/${detail.slug}/${source.slug}`,
          lastModified: source.latestDate ? new Date(source.latestDate) : now,
          changeFrequency: "daily",
          priority: 0.7,
        });
      }

      for (const product of detail.products ?? []) {
        productEntries.push({
          url: `${BASE_URL}/${detail.slug}/product/${product.slug}`,
          lastModified: now,
          changeFrequency: "daily",
          priority: 0.7,
        });
      }
    }

    dynamicEntries = [...orgEntries, ...productEntries, ...sourceEntries];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return [...staticEntries, ...dynamicEntries];
}
