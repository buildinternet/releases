import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiSetupError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { HighlightsView } from "@/components/highlights-view";
import { buildSourceEntityJsonLd, sourceBreadcrumbItems } from "@/lib/schema-org";
import { getSource } from "../_lib/source-data";
import { enableOnDemandIsr } from "@/lib/static-params";

// On-demand ISR: render once per source on first request, then serve from cache
// (revalidated every 60s). See `enableOnDemandIsr`. (#1607)
export const revalidate = 60;
export const generateStaticParams = enableOnDemandIsr;

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
      title: `${source.name} Highlights — ${orgName}`,
      description: `Curated highlights and monthly summaries for ${source.name} by ${orgName}.`,
      openGraph: { type: "website", url: `/${orgSlug}/${slug}/highlights` },
      alternates: { canonical: `/${orgSlug}/${slug}/highlights` },
    };
  } catch {
    return { title: slug };
  }
}

export default async function SourceHighlightsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}) {
  const { orgSlug, slug } = await params;

  let source;
  try {
    source = await getSource(orgSlug, slug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const hasContent = !!(source.summaries?.rolling || source.summaries?.monthly?.length);
  if (!hasContent) notFound();

  const sourceUrl = `https://releases.sh/${orgSlug}/${slug}`;
  const pageUrl = `${sourceUrl}/highlights`;
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
