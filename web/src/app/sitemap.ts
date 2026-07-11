import type { MetadataRoute } from "next";
import { api, ApiSetupError } from "@/lib/api";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { adminDocs, statusDashboard } from "@/flags";
import { getStaticBaseUrl } from "@/lib/base-url";
import { docsManifest } from "@/lib/docs-manifest";
import { buildEntitySitemapEntries, buildUpdatesSitemapEntries } from "@/lib/sitemap-entries";

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

// A sitemap should list only canonical, indexable, content-bearing URLs.
// Deliberately excluded:
//   - /search — `robots: index:false`; a noindex URL must not be in the sitemap.
//   - /live — a real-time feed whose content duplicates the homepage + /updates;
//     it carries no unique indexable value, and a `changeFrequency: "always"`
//     entry just burns crawl budget. Still reachable in-nav, just not submitted.
const ALWAYS_PUBLIC: StaticRoute[] = [
  { path: "/", changeFrequency: "hourly", priority: 1.0 },
  { path: "/updates", changeFrequency: "daily", priority: 0.7 },
  { path: "/categories", changeFrequency: "weekly", priority: 0.5 },
];

// The self-changelog org (see the /updates page). Per-day rollup permalinks
// live at /updates/<date>; enumerate them so each entry is independently
// indexable. Kept to its own guarded fetch so a failure degrades gracefully.
const UPDATES_ORG_SLUG = "releases-sh";

async function updatesEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const feed = await api.orgReleases(UPDATES_ORG_SLUG, { limit: 100 });
    return buildUpdatesSitemapEntries(
      feed.releases.map((r) => r.publishedAt),
      BASE_URL,
    );
  } catch {
    return [];
  }
}

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
  const staticRoutes: StaticRoute[] = [
    ...ALWAYS_PUBLIC,
    ...docsRoutes(),
    ...(statusDashboard ? STATUS_ROUTES : []),
  ];

  // No `lastModified` here: these are static/docs routes with no real
  // updatedAt signal — stamping `now` on every generation just teaches
  // Google to distrust our lastmod. Omitting the field is valid per the
  // sitemap spec.
  const staticEntries: MetadataRoute.Sitemap = staticRoutes.map((r) => ({
    url: `${BASE_URL}${r.path}`,
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
      // Only a real lastActivity drives lastmod; no fabricated `now` fallback.
      const lastModified = org.lastActivity ? new Date(org.lastActivity) : undefined;
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

    // Weekly digest permalinks — the net-new editorial surface (WS3).
    // `lastModified` = generation time; digests are immutable-ish once
    // written, so no fabricated "now" fallback.
    const digestEntries: MetadataRoute.Sitemap = (data.digests ?? []).map((d) => ({
      url: `${BASE_URL}/collections/${d.collectionSlug}/digest/${d.weekStart}`,
      lastModified: new Date(d.generatedAt),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    }));

    // Category overlays have no real updatedAt — same reasoning as
    // staticEntries above, omit rather than fake `now`.
    const categoryEntries: MetadataRoute.Sitemap = CATEGORIES.map((slug) => ({
      url: `${BASE_URL}/categories/${slug}`,
      changeFrequency: "daily" as const,
      priority: 0.5,
    }));

    // /tags/[slug] pages are indexable but deliberately NOT sitemapped here —
    // considered for this PR and deferred (candidate rule: only tags with
    // >=5 releases). Revisit as its own decision.

    dynamicEntries = [
      ...orgEntries,
      ...entityEntries,
      ...collectionEntries,
      ...digestEntries,
      ...categoryEntries,
    ];
  } catch (err) {
    if (!(err instanceof ApiSetupError)) throw err;
  }

  return [...staticEntries, ...dynamicEntries, ...(await updatesEntries())];
}
