import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Suspense } from "react";
import { ApiNotFoundError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { ChangelogView, ChangelogSkeleton } from "@/components/changelog-view";
import { buildSourceEntityJsonLd, sourceBreadcrumbItems } from "@/lib/schema-org";
import { getSourceById } from "../_lib/source-by-id";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const source = await getSourceById(id);
    const orgName = source.org?.name ?? id;
    return {
      title: `${source.name} Changelog File — ${orgName}`,
      description: `Read the CHANGELOG.md file from the ${source.name} repository by ${orgName}.`,
      openGraph: { type: "website", url: `/sources/${id}/changelog` },
      alternates: { canonical: `/sources/${id}/changelog` },
    };
  } catch {
    return { title: id };
  }
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function SourceByIdChangelogPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    path?: string | string[];
    offset?: string | string[];
  }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const changelogPath = firstParam(sp.path);
  const offsetParam = firstParam(sp.offset);
  const changelogOffset = (() => {
    if (!offsetParam) return undefined;
    const n = parseInt(offsetParam, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

  let source;
  try {
    source = await getSourceById(id);
  } catch (err) {
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Orphan source (has org, no productId) → canonical changelog is the bare path.
  if (source.org && !source.productId) {
    permanentRedirect(`/${source.org.slug}/${source.slug}/changelog`);
  }

  if (!source.hasChangelogFile) notFound();

  const orgSlug = source.org?.slug ?? "";
  // Member sources are canonical at /sources/:id; sourceless too; only a non-member
  // with an org uses bare (orphans-with-org are redirected above).
  const sourceUrl = source.productId
    ? `https://releases.sh/sources/${id}`
    : source.org
      ? `https://releases.sh/${source.org.slug}/${source.slug}`
      : `https://releases.sh/sources/${id}`;
  const pageUrl = `https://releases.sh/sources/${id}/changelog`;

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
