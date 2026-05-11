import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiSetupError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { HighlightsView } from "@/components/highlights-view";
import { getSource } from "../_lib/source-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug, sourceSlug } = await params;
  try {
    const source = await getSource(orgSlug, sourceSlug);
    const orgName = source.org?.name ?? orgSlug;
    return {
      title: `${source.name} Highlights — ${orgName}`,
      description: `Curated highlights and monthly summaries for ${source.name} by ${orgName}.`,
      openGraph: { type: "website", url: `/${orgSlug}/${sourceSlug}/highlights` },
      alternates: { canonical: `/${orgSlug}/${sourceSlug}/highlights` },
    };
  } catch {
    return { title: sourceSlug };
  }
}

export default async function SourceHighlightsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;

  let source;
  try {
    source = await getSource(orgSlug, sourceSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const hasContent = !!(source.summaries?.rolling || source.summaries?.monthly?.length);
  if (!hasContent) notFound();

  const sourceUrl = `https://releases.sh/${orgSlug}/${sourceSlug}`;
  const pageUrl = `${sourceUrl}/highlights`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: `${source.name} Highlights`,
        url: pageUrl,
        about: {
          "@type": "SoftwareApplication",
          name: source.name,
          url: sourceUrl,
          ...(source.org ? { publisher: { "@type": "Organization", name: source.org.name } } : {}),
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          ...(source.org
            ? [
                {
                  "@type": "ListItem",
                  position: 2,
                  name: source.org.name,
                  item: `https://releases.sh/${source.org.slug}`,
                },
                { "@type": "ListItem", position: 3, name: source.name, item: sourceUrl },
                { "@type": "ListItem", position: 4, name: "Highlights", item: pageUrl },
              ]
            : [
                { "@type": "ListItem", position: 2, name: source.name, item: sourceUrl },
                { "@type": "ListItem", position: 3, name: "Highlights", item: pageUrl },
              ]),
        ],
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
