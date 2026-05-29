import type { Metadata } from "next";
import { safeStringifyJsonLd } from "@/lib/json-ld";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Suspense, ViewTransition } from "react";
import { api, API_URL, ApiSetupError } from "@/lib/api";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { EXTERNAL_UGC_REL } from "@/lib/sanitize";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { CliCommand } from "@/components/cli-command";
import { AlsoCoveredBy } from "@/components/also-covered-by";
import { RelatedRail } from "@/components/related-rail";
import { ReleaseContent } from "./release-content";
import ReactMarkdown from "react-markdown";
import { createRemarkPlugins, githubRepoUrlFor } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { AI_SUMMARY_DISCLAIMER } from "@/lib/copy";
import { RollupBadge } from "@/components/rollup-badge";
import { CompositionChip } from "@/components/composition-chip";
import { ReleaseAdminMenu } from "@/components/release-admin-menu";
import { FallbackImage } from "@/components/fallback-image";
import { appStoreIconUrl } from "@/lib/app-source";
import { deriveFeedTitle } from "@/lib/release-title";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const release = await api.release(id);
    const { descriptive, versionLabel } = deriveFeedTitle(release);
    const heading = descriptive ?? versionLabel ?? release.title;
    // Keep the version discoverable in the title tag for version-specific search
    // even when the descriptive headline leads.
    const titleHeading = descriptive && versionLabel ? `${heading} (${versionLabel})` : heading;
    const rawDesc = release.summary ?? release.content ?? "";
    const stripped = rawDesc
      .replace(/[#*[\]`>_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const description = stripped.length > 160 ? stripped.slice(0, 157) + "..." : stripped;
    return {
      title: `${titleHeading} — ${release.sourceName}`,
      description: description || `${heading} release notes for ${release.sourceName}`,
      openGraph: {
        type: "article",
        url: `/release/${id}`,
        publishedTime: release.publishedAt ?? undefined,
      },
      alternates: { canonical: `/release/${id}` },
    };
  } catch {
    return { title: "Release" };
  }
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function ReleaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let release;
  try {
    release = await api.release(id);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    notFound();
  }

  const sourcePath = release.org
    ? `/${release.org.slug}/${release.sourceSlug}`
    : `/source/${release.sourceSlug}`;

  const appStore = release.appStore ?? null;
  // App Store screenshots are store marketing, not release content — drop them.
  const media = appStore ? [] : (release.media ?? []);

  const repoUrl = release.sourceType === "github" ? githubRepoUrlFor(release.url) : null;
  const detailRemarkPlugins = createRemarkPlugins({ repoUrl });

  // Title hierarchy mirrors the feed (#feed-title): the descriptive title leads
  // the H1 and the version is demoted to a subtitle. The org/source already
  // appears in the breadcrumb and byline, so the heading doesn't repeat the
  // product name. See web/src/lib/release-title.ts.
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  const heading = descriptive ?? versionLabel ?? release.title;
  // Breadcrumb crumb stays tight: the version when present, else the heading.
  const crumbLabel = versionLabel ?? heading;
  // Version subtitle, shown only when the descriptive title is leading the H1.
  const showVersionSubtitle = !!descriptive && !!versionLabel;
  const trimmedSummary = release.summary?.trim();
  const hasBody = release.content?.trim();
  const adminEnabled = isLocalAdminEnabled();

  const releaseUrl = `https://releases.sh/release/${id}`;
  const sourceUrl = `https://releases.sh${sourcePath}`;
  const breadcrumbItems = [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
    ...(release.org
      ? [
          {
            "@type": "ListItem",
            position: 2,
            name: release.org.name,
            item: `https://releases.sh/${release.org.slug}`,
          },
          { "@type": "ListItem", position: 3, name: release.sourceName, item: sourceUrl },
          { "@type": "ListItem", position: 4, name: crumbLabel || "Release", item: releaseUrl },
        ]
      : [
          { "@type": "ListItem", position: 2, name: release.sourceName, item: sourceUrl },
          { "@type": "ListItem", position: 3, name: crumbLabel || "Release", item: releaseUrl },
        ]),
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: heading,
        datePublished: release.publishedAt ?? undefined,
        mainEntityOfPage: { "@type": "WebPage", "@id": releaseUrl },
        url: releaseUrl,
        author: { "@type": "Organization", name: release.sourceName },
        publisher: { "@type": "Organization", name: "Releases", url: "https://releases.sh" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: breadcrumbItems,
      },
    ],
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeStringifyJsonLd(jsonLd) }}
      />
      <Header />
      <div className="max-w-3xl mx-auto px-6">
        {/* Breadcrumb */}
        <div className="pt-5 text-[13px] text-stone-400 dark:text-stone-500">
          {release.org && (
            <>
              <Link
                href={`/${release.org.slug}`}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                {release.org.name}
              </Link>
              <span className="mx-1.5">/</span>
            </>
          )}
          <Link href={sourcePath} className="hover:text-stone-600 dark:hover:text-stone-300">
            {release.sourceName}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">{crumbLabel}</span>
        </div>

        {/* Header */}
        <div className="mt-6 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <ViewTransition name={`rel-${id}`} default="none">
              <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
                {heading}
              </h1>
            </ViewTransition>
            <RollupBadge type={release.type} />
          </div>
          {showVersionSubtitle && (
            <p className="text-lg text-stone-600 dark:text-stone-400 mt-1">{versionLabel}</p>
          )}
          <div className="flex items-center gap-3 mt-3 text-[13px] text-stone-400 dark:text-stone-500">
            {release.publishedAt && <span>{formatDate(release.publishedAt)}</span>}
            <span className="flex items-center gap-1.5">
              <SourceTypeIcon type={release.sourceType} size={14} />
              <Link href={sourcePath} className="hover:text-stone-600 dark:hover:text-stone-300">
                {release.sourceName}
              </Link>
            </span>
            {appStore && (
              <span className="flex items-center gap-1.5">
                {appStore.iconUrl && (
                  <FallbackImage
                    src={appStoreIconUrl(appStore.iconUrl, 64)}
                    alt=""
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                  />
                )}
                Available for {appStore.platform === "macos" ? "macOS" : "iOS"}
              </span>
            )}
            {release.url && (
              <a
                href={release.url}
                target="_blank"
                rel={EXTERNAL_UGC_REL}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                View original ↗
              </a>
            )}
            {adminEnabled && (
              <span className="ml-auto">
                <ReleaseAdminMenu
                  releaseId={release.id}
                  redirectTo={sourcePath}
                  rawJsonHref={`${API_URL}/v1/releases/${encodeURIComponent(release.id)}`}
                />
              </span>
            )}
          </div>
          {/* Composition legend + copy-command stack vertically — both are
              inline-flex, so without a block wrapper they collide on one line. */}
          <div className="mt-3 flex flex-col items-start gap-3">
            <CompositionChip composition={release.composition} />
            <CliCommand identifier={release.id} className="" />
          </div>
        </div>

        {/* Content */}
        <div className="pb-12">
          {trimmedSummary && hasBody && (
            <aside className="bg-stone-50 dark:bg-stone-900/50 border border-stone-200 dark:border-stone-800 rounded-lg p-5 mb-6">
              <div className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium mb-3">
                Summary
              </div>
              <div className="prose prose-stone dark:prose-invert max-w-none text-[15px] leading-relaxed text-stone-700 dark:text-stone-200 [&_p]:my-0 [&_code]:text-sm [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400">
                <ReactMarkdown
                  remarkPlugins={detailRemarkPlugins}
                  rehypePlugins={[rehypeShikiPlugin]}
                  components={detailMarkdownComponents}
                >
                  {trimmedSummary}
                </ReactMarkdown>
              </div>
              <div className="mt-4 pt-3 border-t border-stone-200 dark:border-stone-800 text-[11px] text-stone-400 dark:text-stone-500">
                {AI_SUMMARY_DISCLAIMER}
              </div>
            </aside>
          )}
          <ReleaseContent
            content={release.content}
            title={release.title}
            media={media}
            repoUrl={repoUrl}
          />
          <Suspense fallback={null}>
            <AlsoCoveredBy anchorReleaseId={release.id} />
          </Suspense>
          {release.org && (
            <Suspense fallback={null}>
              <RelatedRail
                anchorReleaseId={release.id}
                scope="org"
                heading={`More from ${release.org.name}`}
              />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <RelatedRail
              anchorReleaseId={release.id}
              scope="global"
              heading="From other products"
              excludeOrgSlug={release.org?.slug ?? null}
            />
          </Suspense>
          {release.fetchedAt && (
            <p
              className="text-xs text-stone-400 dark:text-stone-500 mt-8"
              title={release.fetchedAt}
            >
              Fetched {formatDate(release.fetchedAt)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
