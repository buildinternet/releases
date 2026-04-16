import type { MetadataRoute } from "next";
import { api, ApiSetupError } from "@/lib/api";
import { adminDocs, statusDashboard } from "@/flags";

// Render on-demand (not during `next build`) so a cold worker / slow D1 can't
// time out the Vercel export. The API response already carries Cache-Control,
// so crawlers hitting this route repeatedly still land on a CDN-cached body.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

const BASE_URL = process.env.RELEASED_BASE_URL?.replace(/\/$/, "") ?? "https://releases.sh";

type StaticRoute = {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
};

const ALWAYS_PUBLIC: StaticRoute[] = [
  { path: "/", changeFrequency: "hourly", priority: 1.0 },
  { path: "/search", changeFrequency: "weekly", priority: 0.5 },
];

const PUBLIC_DOCS_ROUTES: StaticRoute[] = [
  { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
  { path: "/docs/installation", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/api/mcp", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/api/rest", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/browsing", changeFrequency: "monthly", priority: 0.6 },
];

const ADMIN_DOCS_ROUTES: StaticRoute[] = [
  { path: "/docs/cli/admin", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/analysis", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/cli/fetching", changeFrequency: "monthly", priority: 0.6 },
];

const STATUS_ROUTES: StaticRoute[] = [
  { path: "/status", changeFrequency: "daily", priority: 0.4 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticRoutes: StaticRoute[] = [
    ...ALWAYS_PUBLIC,
    ...PUBLIC_DOCS_ROUTES,
    ...(adminDocs ? ADMIN_DOCS_ROUTES : []),
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
