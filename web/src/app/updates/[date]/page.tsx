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

const ORG_SLUG = "releases-sh";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One rollup release per active day. The feed is small and grows ~1/day, so a
// single page pull + date match is cheaper than a dedicated by-date endpoint.
async function findReleaseForDate(date: string) {
  const feed = await api.orgReleases(ORG_SLUG, { limit: 100 });
  return feed.releases.find((r) => (r.publishedAt ?? "").slice(0, 10) === date) ?? null;
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
  if (!DATE_RE.test(date)) return { title: "What's New · releases.sh" };
  try {
    const release = await findReleaseForDate(date);
    if (!release) return { title: "What's New · releases.sh" };
    const heading = releaseHeading(release);
    return {
      title: `${heading} · What's New · releases.sh`,
      description: `What shipped on releases.sh on ${release.title}.`,
      alternates: { canonical: `/updates/${date}` },
      openGraph: {
        title: `${heading} · releases.sh`,
        url: `/updates/${date}`,
        type: "article",
      },
    };
  } catch {
    return { title: "What's New · releases.sh" };
  }
}

export default async function UpdatesDatePage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!DATE_RE.test(date)) notFound();

  const release = await findReleaseForDate(date);
  if (!release) notFound();

  const heading = releaseHeading(release);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: heading,
    url: `https://releases.sh/updates/${date}`,
    ...(release.publishedAt ? { datePublished: release.publishedAt } : {}),
    publisher: { "@type": "Organization", name: "Releases", url: "https://releases.sh" },
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
        <h1 className="mt-3 text-[26px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
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
