import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgAdminPanel } from "@/components/org-admin-panel";
import { isAdminViewer } from "@/lib/server-session";
import { getOrg, getOrgOverview } from "../../_lib/org-data";

export const metadata: Metadata = {
  // Admin-only surface — keep it out of search indexes.
  robots: { index: false, follow: false },
};

export default async function OrgAdminPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  if (!(await isAdminViewer())) notFound();

  const { orgSlug } = await params;
  let org;
  try {
    org = await getOrg(orgSlug);
  } catch {
    notFound();
  }

  // Overview timestamps for status hints — fail-open if the knowledge page is missing.
  const overview = await getOrgOverview(orgSlug);

  return (
    <OrgAdminPanel
      orgSlug={org.slug}
      name={org.name}
      isHidden={org.isHidden ?? false}
      autoGenerateContent={org.autoGenerateContent ?? false}
      featured={org.featured ?? false}
      discovery={org.discovery ?? undefined}
      fetchPaused={org.fetchPaused ?? undefined}
      notice={org.notice}
      overviewCadenceDays={org.overviewCadenceDays}
      overviewGeneratedAt={overview?.generatedAt ?? null}
      overviewUpdatedAt={overview?.updatedAt ?? null}
      lastPolledAt={org.lastPolledAt ?? null}
      lastFetchedAt={org.lastFetchedAt ?? null}
      products={org.products.map((p) => ({
        slug: p.slug,
        name: p.name,
        sourceCount: p.sourceCount,
      }))}
    />
  );
}
