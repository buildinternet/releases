import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { ReleaseContent } from "./release-content";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const release = await api.release(id);
    const heading = release.version ?? release.title;
    const rawDesc = release.contentSummary ?? release.content ?? "";
    const stripped = rawDesc.replace(/[#*\[\]`>_~]/g, "").replace(/\s+/g, " ").trim();
    const description = stripped.length > 160 ? stripped.slice(0, 157) + "..." : stripped;
    return {
      title: `${heading} — ${release.sourceName}`,
      description: description || `${heading} release notes for ${release.sourceName}`,
      openGraph: {
        type: "article",
        publishedTime: release.publishedAt ?? undefined,
      },
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
  });
}

export default async function ReleaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  const media = release.media ?? [];

  const hasVersion = !!release.version;
  const titleMatchesVersion =
    release.title === release.version ||
    release.title === release.version?.replace(/^v/, "") ||
    release.version === release.title?.replace(/^v/, "");

  const heading = hasVersion ? release.version : release.title;
  const showSubtitle = hasVersion && release.title && !titleMatchesVersion;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": heading,
    "datePublished": release.publishedAt ?? undefined,
    "author": { "@type": "Organization", "name": release.sourceName },
    "publisher": { "@type": "Organization", "name": "Released", "url": "https://releases.sh" },
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
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
          <Link
            href={sourcePath}
            className="hover:text-stone-600 dark:hover:text-stone-300"
          >
            {release.sourceName}
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">
            {heading}
          </span>
        </div>

        {/* Header */}
        <div className="mt-6 mb-6">
          <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
            {heading}
          </h1>
          {showSubtitle && (
            <p className="text-lg text-stone-600 dark:text-stone-400 mt-1">
              {release.title}
            </p>
          )}
          <div className="flex items-center gap-3 mt-3 text-[13px] text-stone-400 dark:text-stone-500">
            {release.publishedAt && (
              <span>{formatDate(release.publishedAt)}</span>
            )}
            <span className="flex items-center gap-1.5">
              <SourceTypeIcon type={release.sourceType} size={14} />
              <Link
                href={sourcePath}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                {release.sourceName}
              </Link>
            </span>
            {release.url && (
              <a
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                View original ↗
              </a>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="pb-12">
          <ReleaseContent
            content={release.content}
            title={release.title}
            media={media}
          />
          {release.fetchedAt && (
            <p className="text-xs text-stone-400 dark:text-stone-500 mt-8" title={release.fetchedAt}>
              Fetched {formatDate(release.fetchedAt)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
