import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiSetupError } from "@/lib/api";
import { SourceTable } from "@/components/source-table";
import { JsonLd } from "@/components/json-ld";
import { getOrg } from "../_lib/org-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  try {
    const org = await getOrg(orgSlug);
    return {
      title: `${org.name} Sources`,
      description: `Every changelog source tracked for ${org.name} — GitHub repos, marketing posts, RSS feeds, and more.`,
      openGraph: { type: "website", url: `/${orgSlug}/sources` },
      alternates: { canonical: `/${orgSlug}/sources` },
    };
  } catch {
    return { title: orgSlug };
  }
}

export default async function OrgSourcesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;

  let org;
  let sparklines: { sources: { slug: string; name: string; sparkline: number[] }[] } | null = null;
  try {
    [org, sparklines] = await Promise.all([
      getOrg(orgSlug),
      api.orgSparklines(orgSlug).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  const sourceSparklines = (() => {
    const map: Record<string, number[]> = {};
    if (sparklines) {
      for (const s of sparklines.sources) {
        map[s.slug] = s.sparkline;
      }
    }
    return Object.keys(map).length > 0 ? map : undefined;
  })();

  const orgUrl = `https://releases.sh/${orgSlug}`;
  const pageUrl = `${orgUrl}/sources`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: `${org.name} Sources`,
        url: pageUrl,
        about: { "@type": "Organization", name: org.name, url: orgUrl },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
          { "@type": "ListItem", position: 2, name: org.name, item: orgUrl },
          { "@type": "ListItem", position: 3, name: "Sources", item: pageUrl },
        ],
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <SourceTable
        sources={org.sources}
        products={org.products}
        orgSlug={orgSlug}
        sourceSparklines={sourceSparklines}
      />
    </>
  );
}
