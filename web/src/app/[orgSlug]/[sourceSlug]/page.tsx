import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { currentPeriod } from "@/lib/schema-org";
import { getSource } from "./_lib/source-data";
import { SourceView } from "../[slug]/_views/source-view";

const LEGACY_SOURCE_TABS = new Set(["highlights", "changelog"]);

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
      title: `${source.name} — ${orgName}`,
      description: `Release notes, changelog, and version history for ${source.name} by ${orgName} — updated ${currentPeriod()}.`,
      openGraph: { type: "website", url: `/${orgSlug}/${sourceSlug}` },
      alternates: {
        canonical: `/${orgSlug}/${sourceSlug}`,
        types: {
          "application/atom+xml": [
            {
              url: `/${orgSlug}/${sourceSlug}.atom`,
              title: `${source.name} release notes — ${orgName}`,
            },
          ],
        },
      },
    };
  } catch {
    return { title: sourceSlug };
  }
}

export default async function SourceReleasesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; sourceSlug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { orgSlug, sourceSlug } = await params;
  const { tab } = await searchParams;
  const tabValue = Array.isArray(tab) ? tab[0] : tab;

  // See `(org)/page.tsx` — same `:orgSlug` greedy-match concern applies here.
  if (tabValue && LEGACY_SOURCE_TABS.has(tabValue)) {
    permanentRedirect(`/${orgSlug}/${sourceSlug}/${tabValue}`);
  }

  let source;
  try {
    source = await getSource(orgSlug, sourceSlug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  return <SourceView orgSlug={orgSlug} source={source} />;
}
