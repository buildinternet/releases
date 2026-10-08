import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Suspense } from "react";
import { ApiSetupError, ApiNotFoundError } from "@/lib/api";
import { JsonLd } from "@/components/json-ld";
import { ChangelogView, ChangelogSkeleton } from "@/components/changelog-view";
import { buildSourceEntityJsonLd, sourceBreadcrumbItems } from "@/lib/schema-org";
import { getSource } from "../../_lib/source-data";
import { getResolved } from "../../_lib/resolve";

/**
 * Shared by the cached `/[org]/[slug]/changelog` route (no query: the default
 * file from its start) and the dynamic `changelog/deep` route that the routing
 * proxy rewrites `?path=` / `?offset=` deep links to. Reading `searchParams` in
 * the cached route would force it to render on every request (#2461).
 */
export async function changelogMetadata(orgSlug: string, slug: string): Promise<Metadata> {
  try {
    const source = await getSource(orgSlug, slug);
    const orgName = source.org?.name ?? orgSlug;
    const canonical = `/${orgSlug}/${slug}/changelog`;
    return {
      title: `${source.name} Changelog File — ${orgName}`,
      description: `Read the CHANGELOG.md file from the ${source.name} repository by ${orgName}.`,
      openGraph: { type: "website", url: canonical },
      alternates: { canonical },
    };
  } catch {
    return { title: slug };
  }
}

export async function ChangelogPage({
  orgSlug,
  slug,
  changelogPath,
  changelogOffset,
}: {
  orgSlug: string;
  slug: string;
  changelogPath?: string;
  changelogOffset?: number;
}) {
  let source;
  try {
    source = await getSource(orgSlug, slug);
  } catch (err) {
    if (err instanceof ApiSetupError) throw err;
    if (!(err instanceof ApiNotFoundError)) throw err;
    // No source owns this slug. After the product-first flip a product can
    // share this URL space, so a bare `/{org}/{product}/changelog` bookmark
    // used to dead-end in a 404. A product spans many sources (no single
    // CHANGELOG.md to render), so send those to the product page instead.
    source = null;
  }

  if (!source) {
    let isProduct = false;
    try {
      const resolved = await getResolved(orgSlug, slug);
      isProduct = resolved.kind === "product";
    } catch (err) {
      if (err instanceof ApiSetupError) throw err;
      // Resolves to nothing (or an unexpected read failure): fall through to 404.
    }
    if (isProduct) permanentRedirect(`/${orgSlug}/${slug}`);
    notFound();
  }

  if (!source.hasChangelogFile) notFound();

  const sourceUrl = `https://releases.sh/${orgSlug}/${slug}`;
  const pageUrl = `${sourceUrl}/changelog`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `${source.name} CHANGELOG`,
        url: pageUrl,
        about: buildSourceEntityJsonLd(source, sourceUrl),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: sourceBreadcrumbItems(source, sourceUrl, "Changelog", pageUrl),
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
