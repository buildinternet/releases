import { permanentRedirect } from "next/navigation";

/**
 * Legacy `/[orgSlug]/product/[productSlug]` prefix. Product pages now live at
 * the bare `/[orgSlug]/[slug]` (resolved product-first by `api.resolve`), so
 * this route only 308-redirects old links and bookmarks to the bare form (#1190).
 */
export default async function LegacyProductRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; productSlug: string }>;
}) {
  const { orgSlug, productSlug } = await params;
  permanentRedirect(`/${orgSlug}/${productSlug}`);
}
