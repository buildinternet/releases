import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ApiNotFoundError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { HighlightsView } from "@/components/highlights-view";
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
      title: `${source.name} Highlights — ${orgName}`,
      description: `Curated highlights and monthly summaries for ${source.name} by ${orgName}.`,
      openGraph: { type: "website", url: `/sources/${id}/highlights` },
      alternates: { canonical: `/sources/${id}/highlights` },
    };
  } catch {
    return { title: id };
  }
}

export default async function SourceByIdHighlightsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let source;
  try {
    source = await getSourceById(id);
  } catch (err) {
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  // Orphan source (has org, no productId) → canonical highlights is the bare path.
  if (source.org && !source.productId) {
    permanentRedirect(`/${source.org.slug}/${source.slug}/highlights`);
  }

  const hasContent = !!(source.summaries?.rolling || source.summaries?.monthly?.length);
  if (!hasContent) notFound();

  // Member sources are canonical at /sources/:id; sourceless too; only a non-member
  // with an org uses bare (orphans-with-org are redirected above).
  const sourceUrl = source.productId
    ? `https://releases.sh/sources/${id}`
    : source.org
      ? `https://releases.sh/${source.org.slug}/${source.slug}`
      : `https://releases.sh/sources/${id}`;
  const pageUrl = `https://releases.sh/sources/${id}/highlights`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: `${source.name} Highlights`,
        url: pageUrl,
        about: buildSourceEntityJsonLd(source, sourceUrl),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: sourceBreadcrumbItems(source, sourceUrl, "Highlights", pageUrl),
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <HighlightsView
        rolling={source.summaries?.rolling ?? null}
        monthly={source.summaries?.monthly ?? []}
      />
    </>
  );
}
