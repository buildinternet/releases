import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { currentPeriod } from "@/lib/schema-org";
import { collapsesToOrg, getOrg, isOrgBelowIndexBar } from "../_lib/org-data";
import { getResolved } from "./_lib/resolve";
import { getSource } from "./_lib/source-data";
import { getProductPage } from "./_lib/product-data";
import { ProductView } from "./_views/product-view";
import { SourceView } from "./_views/source-view";
import { enableOnDemandIsr } from "@/lib/static-params";
import { NOINDEX_FOLLOW } from "@/lib/index-policy";

// On-demand ISR: render once per product/source on first request, then serve
// from cache (regenerated on ingest via POST /api/revalidate; 24h backstop).
// Keep in sync with DEFAULT_REVALIDATE_SECONDS (src/lib/isr.ts): the route
// revalidates at the min() of this and every fetch revalidate on it.
export const revalidate = 86400;
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
    // Products and sources follow their org's index bar. A failed org lookup
    // leaves the page indexable rather than guessing.
    const orgBelowBar = org != null && (await isOrgBelowIndexBar(org));
    const orgNoIndex = org?.isHidden === true || org?.discovery === "on_demand" || orgBelowBar;
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
        ...(orgNoIndex ? { robots: { index: false, follow: true } } : {}),
        openGraph: { type: "website", url: `/${orgSlug}/${slug}` },
        alternates: {
          canonical: `/${orgSlug}/${slug}`,
          types: {
            "text/markdown": `/${orgSlug}/${slug}.md`,
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
    const canonical = `/${orgSlug}/${slug}`;
    return {
      title: `${source.name} — ${orgName}`,
      description: `Release notes, changelog, and version history for ${source.name} by ${orgName} — updated ${currentPeriod()}.`,
      // Sources are inputs to the org and product views, which are the pages we
      // offer for indexing. A source page stays reachable and linked.
      robots: NOINDEX_FOLLOW,
      openGraph: { type: "website", url: canonical },
      alternates: {
        canonical,
        types: {
          "text/markdown": `/${orgSlug}/${slug}.md`,
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
    // Retryable 5xx, deliberately not notFound — same policy as layout.tsx
    // (#source-page-500): a cached 404 on this ISR route would risk deindexing a
    // real page during a transient API failure, which a 5xx retry avoids.
    throw err;
  }

  if (resolved.kind === "product") {
    const org = await getOrg(orgSlug);
    if (collapsesToOrg(org)) permanentRedirect(`/${orgSlug}`);
    // Critical path via ProductPage GraphQL: identity + sources + collections
    // + first product-scoped feed page. Overview / activity / heatmap stay on
    // fail-open REST inside ProductView (#2047). REST fallback inside
    // getProductPage covers PersistedQueryNotFound deploy windows.
    const { product, collections, releases } = await getProductPage({
      id: resolved.product.id,
      orgSlug,
      productSlug: resolved.product.slug,
    });
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
