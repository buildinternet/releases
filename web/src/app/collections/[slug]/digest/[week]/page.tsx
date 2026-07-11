import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { isDateKey, etWeekStart, addDaysToDateKey } from "@buildinternet/releases-core/dates";
import { ApiNotFoundError, ApiSetupError } from "@/lib/api";
import type { DigestCoveredRelease } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { SetupMessage } from "@/components/setup-message";
import { buildDigestJsonLd } from "@/lib/schema-org";
import { renderBodyMarkdownToHtml } from "@/lib/render-release-body";
import { getDigestPage } from "../_lib/digest-data";

// Content is immutable-ish once generated — standard ISR window, kept in
// sync with applyCacheInit's default (web/src/lib/api.ts).
export const revalidate = 900;

const SITE_URL = "https://releases.sh";
const MAX_TITLE_LEN = 70;

function weekRangeLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const endKey = addDaysToDateKey(weekStart, 6);
  const end = new Date(`${endKey}T00:00:00Z`);
  const startMonth = start.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const endMonth = end.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const year = end.toLocaleDateString("en-US", { year: "numeric", timeZone: "UTC" });
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  if (startMonth === endMonth) {
    return `${startMonth} ${startDay}–${endDay}, ${year}`;
  }
  return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${year}`;
}

function weekOfLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return `Week of ${start.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
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
      alternates: { canonical: path },
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

  // Markdown body → sanitized HTML via the shared server-side pipeline
  // (remark-rehype with no `allowDangerousHtml`, so raw HTML in the
  // model-generated body is dropped rather than rendered; `isSafeHref` /
  // `isSafeImgSrc` additionally strip unsafe URL schemes on any links/images
  // that do parse). Same pipeline the release-body renderer uses — see
  // web/src/lib/render-release-body.ts.
  const bodyHtml = renderBodyMarkdownToHtml(digest.body, "full");

  const collectionUrl = `${SITE_URL}/collections/${slug}`;
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

  const jsonLd = buildDigestJsonLd(
    {
      title: digest.title,
      intro: digest.intro,
      weekEndDate,
      generatedAt: digest.generatedAt,
      releaseUrls: digest.releases.map((r) => `${SITE_URL}${r.path}`),
    },
    { pageUrl, collectionName: detail.name, collectionUrl },
  );

  const prevWeek = addDaysToDateKey(weekStart, -7);
  const nextWeek = addDaysToDateKey(weekStart, 7);
  const isFutureNext = new Date(`${nextWeek}T00:00:00Z`).getTime() > Date.now();

  return (
    <div className="org-surface min-h-screen bg-[var(--page)] text-[var(--fg)]">
      <JsonLd data={jsonLd} />
      <article className="mx-auto max-w-[760px] px-6 pb-24 pt-5">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--fg-3)]">
          <Link href="/" className="transition-colors hover:text-[var(--fg-2)]">
            Home
          </Link>
          <span className="text-[var(--line-2)]">/</span>
          <Link href="/collections" className="transition-colors hover:text-[var(--fg-2)]">
            Collections
          </Link>
          <span className="text-[var(--line-2)]">/</span>
          <Link
            href={`/collections/${slug}`}
            className="transition-colors hover:text-[var(--fg-2)]"
          >
            {detail.name}
          </Link>
          <span className="text-[var(--line-2)]">/</span>
          <span className="text-[var(--fg-2)]">{weekOfLabel(weekStart)}</span>
        </div>

        <h1 className="mt-4 text-balance text-[32px] font-bold tracking-tight text-[var(--fg)]">
          {digest.title}
        </h1>
        <p className="mt-1.5 text-[14px] font-medium text-[var(--fg-3)]">
          {weekRangeLabel(weekStart)}
        </p>
        <p className="mt-4 max-w-[65ch] text-pretty text-[17px] leading-relaxed text-[var(--fg-2)]">
          {digest.intro}
        </p>

        <div
          className="prose prose-sm mt-8 max-w-none text-[var(--fg-2)] [&_a]:text-[var(--accent)] [&_h3]:mt-8 [&_h3]:text-[18px] [&_h3]:font-semibold [&_h3]:text-[var(--fg)]"
          // Sanitized server-side — see the renderBodyMarkdownToHtml call above.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />

        {orgGroups.length > 0 && (
          <section className="mt-12 border-t border-[var(--line-2)] pt-8">
            <h2 className="text-[15px] font-semibold text-[var(--fg)]">Releases covered</h2>
            <div className="mt-4 flex flex-col gap-5">
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
          </section>
        )}

        <nav className="mt-12 flex items-center justify-between border-t border-[var(--line-2)] pt-6 text-[13px]">
          <Link
            href={`/collections/${slug}/digest/${prevWeek}`}
            className="text-[var(--fg-3)] transition-colors hover:text-[var(--fg-2)]"
          >
            ← Previous week
          </Link>
          {!isFutureNext && (
            <Link
              href={`/collections/${slug}/digest/${nextWeek}`}
              className="text-[var(--fg-3)] transition-colors hover:text-[var(--fg-2)]"
            >
              Next week →
            </Link>
          )}
        </nav>
      </article>
    </div>
  );
}
