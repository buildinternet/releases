import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { currentPeriod } from "@/lib/schema-org";
import { getOrg } from "../_lib/org-data";
import { getResolved } from "./_lib/resolve";
import { ProductView } from "./_views/product-view";
import { SourceView } from "./_views/source-view";

const LEGACY_SOURCE_TABS = new Set(["highlights", "changelog"]);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  try {
    const resolved = await getResolved(orgSlug, slug);
    if (resolved.kind === "product") {
      const product = resolved.product;
      // Product canonical is the BARE form now (links.ts is flipped). The
      // bare `.atom` route resolves product-first (#1210), so advertise the
      // product's cross-source feed the same way the source branch does.
      return {
        title: `${product.name} Release Notes & Changelog`,
        description:
          product.description ?? `Release notes, changelog, and updates for ${product.name}.`,
        openGraph: { type: "website", url: `/${orgSlug}/${slug}` },
        alternates: {
          canonical: `/${orgSlug}/${slug}`,
          types: {
            "application/atom+xml": [
              {
                url: `/${orgSlug}/${slug}.atom`,
                title: `${product.name} release notes`,
              },
            ],
          },
        },
      };
    }
    const source = resolved.source;
    const orgName = source.org?.name ?? orgSlug;
    return {
      title: `${source.name} — ${orgName}`,
      description: `Release notes, changelog, and version history for ${source.name} by ${orgName} — updated ${currentPeriod()}.`,
      openGraph: { type: "website", url: `/${orgSlug}/${slug}` },
      alternates: {
        canonical: `/${orgSlug}/${slug}`,
        types: {
          "application/atom+xml": [
            {
              url: `/${orgSlug}/${slug}.atom`,
              title: `${source.name} release notes — ${orgName}`,
            },
          ],
        },
      },
    };
  } catch {
    return { title: slug };
  }
}

export default async function OrgSlugPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { orgSlug, slug } = await params;

  let resolved;
  try {
    resolved = await getResolved(orgSlug, slug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (err instanceof ApiNotFoundError) notFound();
    throw err;
  }

  if (resolved.kind === "product") {
    // Single-product collapse: with ≤1 product the org page is already this
    // product's feed, so the product page would be duplicate content. 308 home.
    const org = await getOrg(orgSlug);
    if (org.products.length <= 1) {
      permanentRedirect(`/${orgSlug}`);
    }
    return (
      <ProductView orgSlug={orgSlug} orgName={org.name} orgId={org.id} product={resolved.product} />
    );
  }

  // Source branch: preserve the legacy `?tab=` deep-link redirect to the
  // path-based sub-tabs. Only a source carries highlights/changelog tabs.
  const { tab } = await searchParams;
  const tabValue = Array.isArray(tab) ? tab[0] : tab;
  if (tabValue && LEGACY_SOURCE_TABS.has(tabValue)) {
    permanentRedirect(`/${orgSlug}/${slug}/${tabValue}`);
  }

  return <SourceView orgSlug={orgSlug} source={resolved.source} />;
}
