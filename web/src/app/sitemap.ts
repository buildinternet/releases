import type { MetadataRoute } from "next";
import { api, ApiSetupError } from "@/lib/api";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { adminDocs, statusDashboard } from "@/flags";
import { getStaticBaseUrl } from "@/lib/base-url";
import { docsManifest } from "@/lib/docs-manifest";
import { buildEntitySitemapEntries } from "@/lib/sitemap-entries";

// Render on-demand (not during `next build`) so a cold worker / slow D1 can't
// time out the Vercel export. The API response already carries Cache-Control,
// so crawlers hitting this route repeatedly still land on a CDN-cached body.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = getStaticBaseUrl();

type StaticRoute = {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
};

const ALWAYS_PUBLIC: StaticRoute[] = [
  { path: "/", changeFrequency: "hourly", priority: 1.0 },
  { path: "/live", changeFrequency: "always", priority: 0.6 },
  { path: "/search", changeFrequency: "weekly", priority: 0.5 },
  { path: "/categories", changeFrequency: "weekly", priority: 0.5 },
];

const STATUS_ROUTES: StaticRoute[] = [
  { path: "/admin/status", changeFrequency: "daily", priority: 0.4 },
];

function docsRoutes(): StaticRoute[] {
  // adminOnly pages stay gated by the same flag the HTML route honors.
  return docsManifest({ includeAdmin: adminDocs }).map((entry) => ({
    path: entry.path,
    changeFrequency: entry.slug === "index" ? "weekly" : "monthly",
    priority: entry.slug === "index" ? 0.7 : 0.6,
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticRoutes: StaticRoute[] = [
    ...ALWAYS_PUBLIC,
    ...docsRoutes(),
    ...(statusDashboard ? STATUS_ROUTES : []),
  ];

  const staticEntries: MetadataRoute.Sitemap = staticRoutes.map((r) => ({
    url: `${BASE_URL}${r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  let dynamicEntries: MetadataRoute.Sitemap = [];

  try {
    const data = await api.sitemap();

    // Each org emits the bare URL (Overview) plus the path-based tab routes
    // added in #875. Without these, Google indexes only the lightweight
    // Overview content and misses the releases feed entirely.
    const orgEntries: MetadataRoute.Sitemap = data.orgs.flatMap((org) => {
      const lastModified = org.lastActivity ? new Date(org.lastActivity) : now;
      return [
        {
          url: `${BASE_URL}/${org.slug}`,
          lastModified,
          changeFrequency: "daily" as const,
          priority: 0.8,
        },
        {
          url: `${BASE_URL}/${org.slug}/releases`,
          lastModified,
          changeFrequency: "daily" as const,
          priority: 0.8,
        },
        {
          url: `${BASE_URL}/${org.slug}/sources`,
          lastModified,
          changeFrequency: "weekly" as const,
          priority: 0.6,
        },
      ];
    });

    // Products + sources (incl. #1190 shadow routing) come from the pure helper.
    const entityEntries = buildEntitySitemapEntries(data, BASE_URL);

    const collectionEntries: MetadataRoute.Sitemap = (data.collections ?? []).map((co) => ({
      url: `${BASE_URL}/collections/${co.slug}`,
      lastModified: new Date(co.updatedAt),
      changeFrequency: "weekly",
      priority: 0.6,
    }));

    const categoryEntries: MetadataRoute.Sitemap = CATEGORIES.map((slug) => ({
      url: `${BASE_URL}/categories/${slug}`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.5,
    }));

    dynamicEntries = [...orgEntries, ...entityEntries, ...collectionEntries, ...categoryEntries];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return [...staticEntries, ...dynamicEntries];
}
