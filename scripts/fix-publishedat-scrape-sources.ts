#!/usr/bin/env bun
/**
 * Patch source metadata for two scrape sources that store releases with broken
 * publishedAt values (issue #1074):
 *
 * 1. `docker-compose-release-notes` — source.url points to a JS SPA page that
 *    redirects to GitHub. Cloudflare Browser Rendering sees no real changelog
 *    content and therefore never extracts dates. Fix: set `metadata.githubUrl`
 *    so the ingest path treats this as a GitHub source and pulls dated releases
 *    directly from the GitHub Releases API.
 *
 * 2. `software-release-notes` (Redis) — source.url is the release-notes index
 *    page which only links to per-version family pages; the older individual
 *    release entries in the link list have dates (e.g. "6.2.12 (August 2022)")
 *    but the newer family entries do not (e.g. "7.22.x releases"). The AI
 *    extracts only the dated old entries, producing `publishedAt ≤ 2022-08-01`.
 *    Fix: enable crawl mode so the crawler follows links two levels deep into
 *    the individual per-build release pages, each of which has a date in the
 *    H1/title. Also set crawlIncludePathPrefix to keep the crawl on the
 *    release-notes subtree and crawlExcludePatterns to skip the legacy bucket.
 *
 * Dry-run by default. Pass `--apply` to write.
 *
 * Usage:
 *   bun scripts/fix-publishedat-scrape-sources.ts           # dry run
 *   bun scripts/fix-publishedat-scrape-sources.ts --apply   # PATCH metadata
 *   RELEASED_API_URL=https://api-staging.releases.sh \
 *     STAGING_ACCESS_KEY=<key> \
 *     bun scripts/fix-publishedat-scrape-sources.ts --apply # staging
 */

import { logger } from "@buildinternet/releases-lib/logger";
import { adminGet, adminPatch } from "./lib/admin-client.js";

interface SourceRow {
  id: string;
  slug: string;
  orgSlug: string | null;
  name: string;
  url: string;
  metadata: Record<string, unknown> | null;
}

interface PatchPlan {
  orgSlug: string;
  sourceSlug: string;
  name: string;
  currentMetadata: Record<string, unknown>;
  patch: Record<string, unknown>;
  rationale: string;
}

const apply = process.argv.includes("--apply");

/**
 * Targets keyed by source slug.
 *
 * docker-compose-release-notes:
 *   Set githubUrl so the ingest path fetches tagged releases via the GitHub
 *   adapter instead of Cloudflare-rendering the SPA redirect page.
 *
 * software-release-notes (Redis Software):
 *   Enable crawl mode with:
 *   - crawlIncludePathPrefix: keep the crawler on the release-notes subtree
 *   - crawlExcludePatterns: block the "legacy-release-notes" aggregate page
 *     (it's a link-only index inside an already link-only index — no dates)
 *   - parseInstructions: tell the AI that dates live in H1/title text as
 *     "(Month YYYY)" and to use the first of the month as the ISO date
 */
const TARGETS: Record<
  string,
  {
    patch: Record<string, unknown>;
    rationale: string;
  }
> = {
  "docker-compose-release-notes": {
    patch: {
      // Route fetches through the GitHub adapter. The docs.docker.com page is a
      // JS SPA that redirects to github.com/docker/compose/releases — Cloudflare
      // Browser Rendering returns no changelog content, so dates cannot be
      // extracted. Setting githubUrl tells the ingest path to use the GitHub
      // Releases API instead, where every release has a machine-readable date.
      githubUrl: "https://github.com/docker/compose",
    },
    rationale:
      "docs.docker.com/compose/release-notes/ is a SPA redirect to GitHub; " +
      "setting githubUrl routes fetches through the GitHub adapter so dates are extracted correctly",
  },
  "software-release-notes": {
    patch: {
      // Enable crawl mode: follow links from the index page two levels deep so
      // the crawler reaches the individual per-build release pages. Those pages
      // have dates in the H1 title (e.g. "Redis Software 7.22.2-116 (April 2026)").
      crawlEnabled: true,
      // Keep the crawl inside the release-notes subtree; off-path links (main
      // docs nav, marketing pages) are naturally excluded by this prefix.
      crawlIncludePathPrefix: "/docs/latest/operate/rs/release-notes/",
      // Skip the legacy-release-notes aggregate page — it's a link-only index
      // with no date information and would burn crawl budget.
      crawlExcludePatterns: [
        "https://redis.io/docs/latest/operate/rs/release-notes/legacy-release-notes/**",
      ],
      // Tell the AI where to find dates: H1 and title text contains the version
      // and "(Month YYYY)" for individual release pages. Month-only dates should
      // map to the first of the month per EXTRACTION_RULES, but the explicit
      // reminder helps on pages that only carry a month-year label.
      parseInstructions:
        "Release dates appear in the H1/page title in the format " +
        '"VERSION (Month YYYY)" (e.g. "Redis Software 7.22.2-116 (April 2026)"). ' +
        "Use the first of the stated month as the ISO date (e.g. 2026-04-01). " +
        "Do not use the footer 'Last updated' timestamp — that reflects the doc build date, " +
        "not the release date.",
    },
    rationale:
      "The release-notes index page only links to per-version family pages; " +
      "individual per-build pages with dates are two levels deep. " +
      "Enabling crawl mode lets the crawler reach them; " +
      "parseInstructions guides the AI to extract dates from H1 text.",
  },
};

async function resolveSource(slug: string): Promise<SourceRow | null> {
  // Try the bare slug via the global sources list. Most sources have globally
  // unique slugs even after #698 (which only enforces org-scoped uniqueness for
  // new writes). A 400 bare_slug_rejected response means we need to look the
  // source up by URL instead.
  const list = await adminGet<{ items?: SourceRow[]; data?: SourceRow[] } | SourceRow[]>(
    `/sources?limit=500`,
    { throwOnError: false },
  );
  if (!list) return null;

  // Handle both array and paginated-object shapes
  const rows: SourceRow[] = Array.isArray(list)
    ? list
    : ((list as { items?: SourceRow[]; data?: SourceRow[] }).items ??
      (list as { items?: SourceRow[]; data?: SourceRow[] }).data ??
      []);

  return rows.find((r) => r.slug === slug) ?? null;
}

async function buildPlan(): Promise<PatchPlan[]> {
  const plans: PatchPlan[] = [];

  for (const [slug, { patch, rationale }] of Object.entries(TARGETS)) {
    // oxlint-disable-next-line no-await-in-loop -- sequential: one GET per source slug, low volume
    const source = await resolveSource(slug);
    if (!source) {
      logger.warn(`  ✗ source not found: ${slug}`);
      continue;
    }
    if (!source.orgSlug) {
      logger.warn(`  ✗ source has no org: ${slug}`);
      continue;
    }
    plans.push({
      orgSlug: source.orgSlug,
      sourceSlug: slug,
      name: source.name,
      currentMetadata: source.metadata ?? {},
      patch,
      rationale,
    });
  }

  return plans;
}

async function main(): Promise<void> {
  logger.info(`fix-publishedat-scrape-sources — ${apply ? "APPLY" : "dry run"}`);
  logger.info("");

  const plans = await buildPlan();
  if (plans.length === 0) {
    logger.warn("No target sources found — nothing to do.");
    return;
  }

  for (const p of plans) {
    logger.info(`Source: ${p.sourceSlug} (${p.name})`);
    logger.info(`  Org: ${p.orgSlug}`);
    logger.info(`  Rationale: ${p.rationale}`);
    logger.info(`  Patch: ${JSON.stringify(p.patch, null, 2)}`);
    logger.info("");

    if (apply) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: one PATCH per source, low volume
      await adminPatch(
        `/orgs/${encodeURIComponent(p.orgSlug)}/sources/${encodeURIComponent(p.sourceSlug)}/metadata`,
        p.patch,
        { throwOnError: true },
      );
      logger.info(`  → PATCH applied for ${p.sourceSlug}`);
    }
  }

  if (!apply) {
    logger.info("Dry run — pass --apply to write changes.");
  } else {
    logger.info(`Applied ${plans.length} metadata patch(es).`);
    logger.info("");
    logger.info("Next steps:");
    logger.info("  1. Trigger a re-fetch for each source (releases admin source fetch <slug>).");
    logger.info("  2. Verify new releases appear with correct publishedAt values.");
    logger.info(
      "  3. Backfill broken rows: null out publishedAt on existing records and " +
        "re-fetch, or run a targeted DB update (separate follow-up — not in this PR).",
    );
  }
}

main().catch((err) => {
  logger.error(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
