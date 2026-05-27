import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApiSetupError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { ChangelogView, ChangelogSkeleton } from "@/components/changelog-view";
import { buildSourceEntityJsonLd, sourceBreadcrumbItems } from "@/lib/schema-org";
import { getSource } from "../_lib/source-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  try {
    const source = await getSource(orgSlug, slug);
    const orgName = source.org?.name ?? orgSlug;
    return {
      title: `${source.name} Changelog File — ${orgName}`,
      description: `Read the CHANGELOG.md file from the ${source.name} repository by ${orgName}.`,
      openGraph: { type: "website", url: `/${orgSlug}/${slug}/changelog` },
      alternates: { canonical: `/${orgSlug}/${slug}/changelog` },
    };
  } catch {
    return { title: slug };
  }
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function SourceChangelogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
  // Next.js delivers repeated query params as `string[]`; collapse to the
  // first value so `?path=a&path=b` doesn't reach the API as an array.
  searchParams: Promise<{
    path?: string | string[];
    offset?: string | string[];
  }>;
}) {
  const { orgSlug, slug } = await params;
  const sp = await searchParams;
  const changelogPath = firstParam(sp.path);
  const offsetParam = firstParam(sp.offset);
  // `offset` arrives from search chunk deep-links so the changelog view can
  // start its initial slice at byte N instead of 0 (the range API's
  // heading-aware slicer snaps forward to the next `##` heading).
  const changelogOffset = (() => {
    if (!offsetParam) return undefined;
    const n = parseInt(offsetParam, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

  let source;
  try {
    source = await getSource(orgSlug, slug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  if (!source.hasChangelogFile) notFound();

  const sourceUrl = `https://releases.sh/${orgSlug}/${slug}`;
  const pageUrl = `${sourceUrl}/changelog`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `${source.name} CHANGELOG`,
        url: pageUrl,
        about: buildSourceEntityJsonLd(source, sourceUrl),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: sourceBreadcrumbItems(source, sourceUrl, "Changelog", pageUrl),
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <Suspense
        key={`${source.slug}:${changelogPath ?? ""}:${changelogOffset ?? 0}`}
        fallback={<ChangelogSkeleton />}
      >
        <ChangelogView
          orgSlug={orgSlug}
          sourceSlug={source.slug}
          path={changelogPath}
          startOffset={changelogOffset}
        />
      </Suspense>
    </>
  );
}
