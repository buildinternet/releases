import type { Metadata } from "next";
import Link from "next/link";
import { permanentRedirect } from "next/navigation";
import { api, ApiNotFoundError, ApiSetupError } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { SetupMessage } from "@/components/setup-message";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { JsonLd } from "@/components/json-ld";
import { OrgCatalog } from "@/components/org-catalog";
import { CategoryFilter } from "@/components/category-filter";
import { groupOrgsByLetter } from "@/lib/group-orgs";
import { catalogHref } from "@/lib/catalog-href";
import { buildOrgCatalogJsonLd } from "@/lib/schema-org";

const TITLE = "Catalog";
const DESCRIPTION =
  "Every organization tracked on releases.sh, A to Z. Browse the full registry of companies whose changelogs and release notes we index.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/catalog" },
  openGraph: {
    type: "website",
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
  searchParams: Promise<{ empty?: string; category?: string }>;
}) {
  const { empty, category: categoryParam } = await searchParams;
  const includeEmpty = empty === "1";

  const setupView = (err: ApiSetupError) => (
    <div className="min-h-screen">
      <SetupMessage message={err.message} steps={err.setup} />
    </div>
  );

  // Resolve the inbound category param so an aliased URL (?category=e-commerce)
  // filters like its canonical sibling (?category=commerce), matching the REST
  // /v1/orgs read filter (#1276). A canonical slug is taken as-is — the common
  // case (chips link canonical), so no extra round-trip. A non-canonical value
  // might be an alias: the category-detail endpoint 301s an alias to its
  // canonical slug and fetch() follows, so `detail.slug` is always canonical (it
  // also drives the chip highlight + redirect below). Unknown values 404 from
  // the API → fail open to the unfiltered catalog, mirroring the read filter's
  // own fail-open on garbage values.
  let category: string | null = null;
  if (categoryParam) {
    if (isValidCategory(categoryParam)) {
      category = categoryParam;
    } else {
      try {
        category = (await api.categoryDetail(categoryParam)).slug;
      } catch (err) {
        if (err instanceof ApiSetupError) return setupView(err);
        if (!(err instanceof ApiNotFoundError)) throw err;
      }
    }
  }

  // Aliased inbound URL → 308 permanent redirect to the canonical category, so
  // search engines consolidate on the canonical ?category= URL (the API itself
  // 301s the alias). permanentRedirect matches the canonical-URL redirects used
  // by the org/source pages; kept outside any try/catch so the framework's
  // redirect signal isn't swallowed.
  if (category && category !== categoryParam) {
    permanentRedirect(catalogHref({ category, includeEmpty }));
  }

  let orgsResult: Awaited<ReturnType<typeof api.orgs>>;
  try {
    orgsResult = await api.orgs({ includeEmpty, category: category ?? undefined });
  } catch (err) {
    if (err instanceof ApiSetupError) return setupView(err);
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
      <div className="mx-auto max-w-3xl px-6 pb-12 pt-8">
        <PageHeader
          breadcrumb={[{ label: "Home", href: "/" }, { label: TITLE }]}
          title={TITLE}
          description={DESCRIPTION}
        />

        <CategoryFilter activeCategory={category} includeEmpty={includeEmpty} />

        {groups.length > 0 ? (
          <OrgCatalog groups={groups} />
        ) : (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {category ? "No organizations in this category yet." : "No organizations yet."}
          </p>
        )}

        {emptyOrgCount > 0 && (
          <Link
            href={catalogHref({ category, includeEmpty: !includeEmpty })}
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
