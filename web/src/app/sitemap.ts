import type { MetadataRoute } from "next";
import { api, ApiSetupError } from "@/lib/api";
import { adminDocs, statusDashboard } from "@/flags";
import { getStaticBaseUrl } from "@/lib/base-url";
import { docsManifest } from "@/lib/docs-manifest";

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
];

const STATUS_ROUTES: StaticRoute[] = [{ path: "/status", changeFrequency: "daily", priority: 0.4 }];

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

    const orgEntries: MetadataRoute.Sitemap = data.orgs.map((org) => ({
      url: `${BASE_URL}/${org.slug}`,
      lastModified: org.lastActivity ? new Date(org.lastActivity) : now,
      changeFrequency: "daily",
      priority: 0.8,
    }));

    const productEntries: MetadataRoute.Sitemap = data.products.map((p) => ({
      url: `${BASE_URL}/${p.orgSlug}/product/${p.slug}`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    }));

    const sourceEntries: MetadataRoute.Sitemap = data.sources.map((s) => ({
      url: `${BASE_URL}/${s.orgSlug}/${s.slug}`,
      lastModified: s.latestDate ? new Date(s.latestDate) : now,
      changeFrequency: "daily",
      priority: 0.7,
    }));

    dynamicEntries = [...orgEntries, ...productEntries, ...sourceEntries];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return [...staticEntries, ...dynamicEntries];
}
