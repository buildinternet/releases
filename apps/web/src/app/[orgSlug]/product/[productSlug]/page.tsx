import { permanentRedirect } from "next/navigation";
import { collapsesToOrg, getOrg } from "../../_lib/org-data";

/**
 * Legacy `/[orgSlug]/product/[productSlug]` prefix. Product pages now live at
 * the bare `/[orgSlug]/[slug]` (#1190), so this route only 308-redirects old
 * links and bookmarks — straight to `/{org}` for a single-product org, rather
 * than hopping through the bare URL's own collapse redirect.
 */
export default async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;
  const org = await getOrg(orgSlug).catch(() => null);
  permanentRedirect(org && collapsesToOrg(org) ? `/${orgSlug}` : `/${orgSlug}/${productSlug}`);
}
