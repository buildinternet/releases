import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { isDateKey, etWeekStart, addDaysToDateKey } from "@buildinternet/releases-core/dates";
import { ApiNotFoundError, ApiSetupError } from "@/lib/api";
import type { DigestCoveredRelease } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { BreadcrumbHome } from "@/components/breadcrumb-home";
import { DigestAdjacentNav } from "@/components/digest-adjacent-nav";
import { DigestBetaNote } from "@/components/digest-beta-note";
import { DigestFacepile, orgsFromCoveredReleases } from "@/components/digest-facepile";
import { DigestFormatLinks } from "@/components/digest-format-links";
import { buildDigestJsonLd } from "@/lib/schema-org";
import { renderBodyMarkdownToHtml } from "@/lib/render-release-body";
import { AI_DIGEST_DISCLAIMER } from "@/lib/copy";
import { weekOfLabel } from "@/lib/digest-format";
import { getDigestIndex, getDigestPage } from "../_lib/digest-data";

// Content is immutable-ish once generated — standard ISR window, kept in
// sync with applyCacheInit's default (web/src/lib/api.ts).
export const revalidate = 900;

const SITE_URL = "https://releases.sh";
const MAX_TITLE_LEN = 70;

// Same base as docs / markdown pages (`markdown-page.tsx`, docs layout): let
// `@tailwindcss/typography` own heading scale; only override code chips.
// (Feed cards use denser `[&_h*]` chains — wrong for a full article body.)

function weekRangeLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const endKey = addDaysToDateKey(weekStart, 6);
  const end = new Date(`${endKey}T00:00:00Z`);
  const startMonth = start.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const endMonth = end.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  if (startYear !== endYear) {
    return `${startMonth} ${startDay}, ${startYear} – ${endMonth} ${endDay}, ${endYear}`;
  }
  if (startMonth === endMonth) {
    return `${startMonth} ${startDay}–${endDay}, ${endYear}`;
  }
  return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${endYear}`;
}

function clampMetaTitle(title: string): string {
  return title.length > MAX_TITLE_LEN ? `${title.slice(0, MAX_TITLE_LEN - 1)}…` : title;
}

/**
 * Resolves `[week]` to a canonical Monday `weekStart`, or `null` for a
 * malformed segment. Doesn't distinguish "valid but not Monday" here — the
 * caller compares against `etWeekStart()` to decide redirect vs. serve.
 */
function parseWeekParam(week: string): string | null {
  return isDateKey(week) ? week : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; week: string }>;
}): Promise<Metadata> {
  const { slug, week } = await params;
  const weekStart = parseWeekParam(week);
  if (!weekStart) return { title: "Digest" };
  const canonicalWeek = etWeekStart(weekStart);
  if (canonicalWeek !== weekStart) return { title: "Digest" };

  try {
    const { detail, digest } = await getDigestPage(slug, weekStart);
    const title = clampMetaTitle(
      `What's new in ${detail.name}: ${digest.title} — ${weekOfLabel(weekStart)}`,
    );
    const path = `/collections/${slug}/digest/${weekStart}`;
    return {
      title,
      description: digest.intro,
      alternates: {
        canonical: path,
        // Point at the aggregate digests feed (no single-item Atom).
        types: {
          "application/atom+xml": [
            {
              url: `/collections/${slug}/digest.atom`,
              title: `${detail.name} weekly digests`,
            },
          ],
        },
      },
      openGraph: { type: "article", url: path, title, description: digest.intro },
    };
  } catch {
    return { title: "Digest" };
  }
}

export default async function CollectionDigestPage({
  params,
}: {
  params: Promise<{ slug: string; week: string }>;
}) {
  const { slug, week } = await params;
  const weekStart = parseWeekParam(week);
  if (!weekStart) notFound();

  const canonicalWeek = etWeekStart(weekStart);
  if (canonicalWeek !== weekStart) {
    permanentRedirect(`/collections/${slug}/digest/${canonicalWeek}`);
  }

  let page;
  try {
    page = await getDigestPage(slug, weekStart);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  const { detail, digest } = page;

  // No heading demotion — digest `###` sections should render as h3 under the
  // page h1 (card/changelog pipelines demote by 2 for their own outline).
  const bodyHtml = renderBodyMarkdownToHtml(digest.body, "full", { demoteHeadings: 0 });

  const collectionUrl = `${SITE_URL}/collections/${slug}`;
  const digestsIndexUrl = `${collectionUrl}/digest`;
  const pageUrl = `${collectionUrl}/digest/${weekStart}`;
  const weekEndDate = addDaysToDateKey(weekStart, 6);

  const releasesByOrg = new Map<
    string,
    { name: string; slug: string; items: DigestCoveredRelease[] }
  >();
  for (const r of digest.releases) {
    const existing = releasesByOrg.get(r.org.slug);
    if (existing) existing.items.push(r);
    else releasesByOrg.set(r.org.slug, { name: r.org.name, slug: r.org.slug, items: [r] });
  }
  const orgGroups = Array.from(releasesByOrg.values()).sort((a, b) => a.name.localeCompare(b.name));
  const facepileOrgs = orgsFromCoveredReleases(digest.releases, detail.members);

  const jsonLd = buildDigestJsonLd(
    {
      title: digest.title,
      intro: digest.intro,
      weekEndDate,
      generatedAt: digest.generatedAt,
      releaseUrls: digest.releases.map((r) => `${SITE_URL}${r.path}`),
    },
    { pageUrl, collectionName: detail.name, collectionUrl, digestsIndexUrl },
  );

  // Prev/next only for weeks that have a digest — the quality floor skips
  // empty weeks at generation, so naive ±7d links would 404. Index is
  // newest-first and shares the request-scoped cache with the digest index.
  let prev: { href: string; weekLabel: string; title: string } | null = null;
  let next: { href: string; weekLabel: string; title: string } | null = null;
  try {
    const { digests } = await getDigestIndex(slug);
    const idx = digests.findIndex((d) => d.weekStart === weekStart);
    if (idx !== -1) {
      const older = digests[idx + 1];
      const newer = digests[idx - 1];
      if (older) {
        prev = {
          href: `/collections/${slug}/digest/${older.weekStart}`,
          weekLabel: weekOfLabel(older.weekStart),
          title: older.title,
        };
      }
      if (newer) {
        next = {
          href: `/collections/${slug}/digest/${newer.weekStart}`,
          weekLabel: weekOfLabel(newer.weekStart),
          title: newer.title,
        };
      }
    }
  } catch {
    // Nav is decorative — render the page without it rather than failing.
  }

  return (
    <div className="org-surface min-h-screen bg-[var(--page)] text-[var(--fg)]">
      <JsonLd data={jsonLd} />
      <article className="mx-auto max-w-[760px] px-6 pb-24 pt-5">
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--fg-3)]"
        >
          <BreadcrumbHome />
          <span className="text-[var(--line-2)]" aria-hidden>
            /
          </span>
          <Link href="/collections" className="transition-colors hover:text-[var(--fg-2)]">
            Collections
          </Link>
          <span className="text-[var(--line-2)]" aria-hidden>
            /
          </span>
          <Link
            href={`/collections/${slug}`}
            className="transition-colors hover:text-[var(--fg-2)]"
          >
            {detail.name}
          </Link>
          <span className="text-[var(--line-2)]" aria-hidden>
            /
          </span>
          <Link
            href={`/collections/${slug}/digest`}
            className="transition-colors hover:text-[var(--fg-2)]"
          >
            Weekly digests
          </Link>
        </nav>

        <DigestBetaNote className="mt-4" />

        <h1 className="mt-4 text-balance text-[32px] font-bold tracking-tight text-[var(--fg)]">
          {digest.title}
        </h1>
        <p className="mt-1.5 text-[14px] font-medium text-[var(--fg-3)]">
          {weekRangeLabel(weekStart)}
        </p>
        <DigestFacepile orgs={facepileOrgs} className="mt-3" />
        <p className="mt-4 max-w-[65ch] text-pretty text-[17px] leading-relaxed text-[var(--fg-2)]">
          {digest.intro}
        </p>
        <DigestFormatLinks
          path={`/collections/${slug}/digest/${weekStart}`}
          atomHref={`/collections/${slug}/digest.atom`}
          className="mt-4"
        />

        <div
          className="prose prose-stone dark:prose-invert mt-8 max-w-none text-[15px] leading-relaxed prose-headings:tracking-tight prose-a:text-stone-600 dark:prose-a:text-stone-400 prose-a:no-underline hover:prose-a:underline prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono"
          // Sanitized server-side — see the renderBodyMarkdownToHtml call above.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />

        <div className="mt-4 border-t border-[var(--line)] pt-3 text-[11px] text-[var(--fg-3)]">
          {AI_DIGEST_DISCLAIMER}
        </div>

        {orgGroups.length > 0 && (
          // Native <details>: starts collapsed (less visual clutter) but the
          // full link list stays in the HTML for crawlers and expand-on-demand.
          <details className="group mt-12 border-t border-[var(--line-2)] pt-6">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[15px] font-semibold text-[var(--fg)] transition-colors hover:text-[var(--fg-2)] [&::-webkit-details-marker]:hidden">
              <svg
                width="9"
                height="9"
                viewBox="0 0 9 9"
                fill="none"
                aria-hidden="true"
                className="shrink-0 text-[var(--fg-3)] transition-transform group-open:rotate-90"
              >
                <path
                  d="M2.5 1.5 L6 4.5 L2.5 7.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Releases covered</span>
              <span className="font-mono text-[11px] font-normal tabular-nums text-[var(--fg-3)]">
                {digest.releases.length}
              </span>
            </summary>
            <div className="mt-4 flex flex-col gap-5 pl-[17px]">
              {orgGroups.map((group) => (
                <div key={group.slug}>
                  <div className="text-[13px] font-medium text-[var(--fg-3)]">{group.name}</div>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {group.items.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={r.path}
                          className="text-[14px] text-[var(--fg-2)] transition-colors hover:text-[var(--accent)]"
                        >
                          {r.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        )}

        <DigestAdjacentNav prev={prev} next={next} />
      </article>
    </div>
  );
}
