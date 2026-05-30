import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError } from "@/lib/api";
import { Header } from "@/components/header";
import { PageHeader } from "@/components/page-header";
import { SetupMessage } from "@/components/setup-message";
import { JsonLd } from "@/components/json-ld";
import { OrgCatalog } from "@/components/org-catalog";
import { groupOrgsByLetter } from "@/lib/group-orgs";
import { buildOrgCatalogJsonLd } from "@/lib/schema-org";

const TITLE = "Catalog";
const DESCRIPTION =
  "Every organization tracked on releases.sh, A to Z. Browse the full registry of companies whose changelogs and release notes we index.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/catalog" },
  openGraph: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
    url: "/catalog",
  },
  twitter: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
  },
};

/**
 * `?empty=1` opts into orgs that are in the registry but have not produced any
 * indexed releases yet — mirrors the home page (#746). Default hides them; the
 * toggle below the table reveals them and is labeled from `meta.emptyOrgCount`.
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ empty?: string }>;
}) {
  const { empty } = await searchParams;
  const includeEmpty = empty === "1";

  let orgsResult: Awaited<ReturnType<typeof api.orgs>>;
  try {
    orgsResult = await api.orgs({ includeEmpty });
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    throw err;
  }

  const { emptyOrgCount } = orgsResult;
  const groups = groupOrgsByLetter(orgsResult.items);

  // Build the structured-data list from the grouped (alphabetical) order so it
  // mirrors the rendered page.
  const jsonLd = buildOrgCatalogJsonLd(
    groups.flatMap((g) => g.orgs),
    { path: "/catalog", name: TITLE, description: DESCRIPTION },
  );

  return (
    <div className="min-h-screen">
      <JsonLd data={jsonLd} />
      <Header />
      <div className="mx-auto max-w-3xl px-6 pb-12 pt-8">
        <PageHeader
          breadcrumb={[{ label: "Home", href: "/" }, { label: TITLE }]}
          title={TITLE}
          description={DESCRIPTION}
        />

        {groups.length > 0 ? (
          <OrgCatalog groups={groups} />
        ) : (
          <p className="text-sm text-stone-500 dark:text-stone-400">No organizations yet.</p>
        )}

        {emptyOrgCount > 0 && (
          <Link
            href={includeEmpty ? "/catalog" : "/catalog?empty=1"}
            className="mt-6 inline-block text-[12px] text-stone-400 underline decoration-stone-300 underline-offset-2 hover:text-stone-600 dark:text-stone-500 dark:decoration-stone-600 dark:hover:text-stone-300"
          >
            {includeEmpty
              ? "Hide empty orgs"
              : `Show ${emptyOrgCount} ${emptyOrgCount === 1 ? "org" : "orgs"} with no indexed releases yet`}
          </Link>
        )}
      </div>
    </div>
  );
}
