import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { api } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { deriveFeedTitle } from "@/lib/release-title";
import { isDateKey } from "@buildinternet/releases-core/dates";

const ORG_SLUG = "releases-sh";

// One rollup release per active day. The feed's date window returns just that
// UTC day, so any day is one request. `until` is spelled as an explicit
// end-of-day instant (not a bare date) so it can't depend on the API's
// bare-date handling.
async function findReleaseForDate(date: string) {
  const feed = await api.orgReleases(ORG_SLUG, {
    since: date,
    until: `${date}T23:59:59.999Z`,
    limit: 1,
  });
  return feed.releases[0] ?? null;
}

// releases.sh's own changelog entries carry the date as their raw `title`; the
// descriptive AI headline (what the feed shows via `deriveFeedTitle`) is the
// more useful heading for the day's page. Fall back to the version, then the
// raw date title.
function releaseHeading(release: {
  title: string;
  version: string | null;
  titleGenerated?: string | null;
  titleShort?: string | null;
}): string {
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  return descriptive ?? versionLabel ?? release.title;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}): Promise<Metadata> {
  const { date } = await params;
  if (!isDateKey(date)) return { title: "What's New" };
  try {
    const release = await findReleaseForDate(date);
    if (!release) return { title: "What's New" };
    const heading = releaseHeading(release);
    return {
      // The root layout's title template appends the site name.
      title: `${heading} · What's New`,
      description: `What shipped on Release Notes Index on ${release.title}.`,
      alternates: { canonical: `/updates/${date}` },
      openGraph: {
        title: `${heading} · Release Notes Index`,
        url: `/updates/${date}`,
        type: "article",
      },
    };
  } catch {
    return { title: "What's New" };
  }
}

export default async function UpdatesDatePage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!isDateKey(date)) notFound();

  const release = await findReleaseForDate(date);
  if (!release) notFound();

  const heading = releaseHeading(release);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: heading,
    url: `https://releases.sh/updates/${date}`,
    ...(release.publishedAt ? { datePublished: release.publishedAt } : {}),
    publisher: { "@type": "Organization", name: "Release Notes Index", url: "https://releases.sh" },
  };

  return (
    <div className="min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <JsonLd data={jsonLd} />
        <Link
          href="/updates"
          className="text-[13px] text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
        >
          ← What&apos;s New
        </Link>
        <h1 className="mt-3 text-[26px] font-bold tracking-tight text-stone-900 dark:text-stone-100 text-balance">
          {heading}
        </h1>
        {/* First-party self-changelog (org "releases-sh"): this page is the
            self-canonical home for releases.sh's own daily update, so it renders
            the full body intentionally. Aggregated third-party feed surfaces
            excerpt instead — see #1606 / releaseExcerpt. */}
        <div className="mt-5 text-[15px] leading-relaxed text-stone-700 dark:text-stone-300">
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={[rehypeShikiPlugin]}
            components={detailMarkdownComponents}
          >
            {release.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
