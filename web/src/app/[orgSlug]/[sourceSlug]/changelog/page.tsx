import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApiSetupError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { ChangelogView, ChangelogSkeleton } from "@/components/changelog-view";
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
      title: `${source.name} CHANGELOG — ${orgName}`,
      description: `Browse the CHANGELOG.md file for ${source.name} by ${orgName}, version by version.`,
      openGraph: { type: "website", url: `/${orgSlug}/${sourceSlug}/changelog` },
      alternates: { canonical: `/${orgSlug}/${sourceSlug}/changelog` },
    };
  } catch {
    return { title: sourceSlug };
  }
}

export default async function SourceChangelogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ path?: string; offset?: string }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { path: changelogPath, offset: offsetParam } = await searchParams;
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
    source = await getSource(orgSlug, sourceSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    notFound();
  }

  if (!source.hasChangelogFile) notFound();

  const sourceUrl = `https://releases.sh/${orgSlug}/${sourceSlug}`;
  const pageUrl = `${sourceUrl}/changelog`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `${source.name} CHANGELOG`,
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
                { "@type": "ListItem", position: 4, name: "Changelog", item: pageUrl },
              ]
            : [
                { "@type": "ListItem", position: 2, name: source.name, item: sourceUrl },
                { "@type": "ListItem", position: 3, name: "Changelog", item: pageUrl },
              ]),
        ],
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
