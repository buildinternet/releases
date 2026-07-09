import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { currentPeriod } from "@/lib/schema-org";
import { getOrg } from "../_lib/org-data";
import { getResolved } from "./_lib/resolve";
import { getSource } from "./_lib/source-data";
import { getProductPage } from "./_lib/product-data";
import { ProductView } from "./_views/product-view";
import { SourceView } from "./_views/source-view";
import { enableOnDemandIsr } from "@/lib/static-params";

// On-demand ISR: render once per product/source on first request, then serve
// from cache (revalidated every 15 min). See `enableOnDemandIsr`. (#1607)
// Keep in sync with applyCacheInit's default (src/lib/api.ts): the route
// revalidates at the min() of this and every fetch revalidate on it.
export const revalidate = 900;
export const generateStaticParams = enableOnDemandIsr;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
}): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  try {
    const [resolved, org] = await Promise.all([
      getResolved(orgSlug, slug),
      getOrg(orgSlug).catch(() => null),
    ]);
    const orgIsHidden = org?.isHidden === true || org?.discovery === "on_demand";
    if (resolved.kind === "product") {
      const product = resolved.product;
      // Product canonical is the BARE form now (links.ts is flipped). The
      // bare `.atom` route resolves product-first (#1210), so advertise the
      // product's cross-source feed the same way the source branch does.
      return {
        title: `${product.name} Release Notes & Changelog · ${currentPeriod()}`,
        description:
          product.description ??
          `Release notes, changelog, and updates for ${product.name} — refreshed ${currentPeriod()}.`,
        ...(orgIsHidden ? { robots: { index: false, follow: true } } : {}),
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
    const shouldNoIndex = source.isHidden || source.discovery === "on_demand" || orgIsHidden;
    return {
      title: `${source.name} — ${orgName}`,
      description: `Release notes, changelog, and version history for ${source.name} by ${orgName} — updated ${currentPeriod()}.`,
      ...(shouldNoIndex ? { robots: { index: false, follow: true } } : {}),
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
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
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
    // Critical path via ProductPage GraphQL: identity + sources + collections
    // + first product-scoped feed page. Overview / activity / heatmap stay on
    // fail-open REST inside ProductView (#2047).
    const { product, collections, releases } = await getProductPage(resolved.product.id);
    return (
      <ProductView
        orgSlug={orgSlug}
        orgName={org.name}
        orgId={org.id}
        product={product}
        collections={collections}
        initialReleases={releases}
      />
    );
  }

  // Source branch. Legacy `?tab=highlights|changelog` deep-links are redirected
  // to the path-based sub-tabs in the routing middleware (`src/proxy.ts`).
  const source = await getSource(orgSlug, slug);
  return <SourceView orgSlug={orgSlug} source={source} />;
}
