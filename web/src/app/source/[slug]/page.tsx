import { notFound, redirect } from "next/navigation";
import { api } from "@/lib/api";

/**
 * Legacy bare-slug source page. Every source now belongs to an org (#690
 * Phase C made `sources.orgId` NOT NULL), so this route only exists to
 * 308-redirect bookmarks and inbound links to the canonical
 * `/[orgSlug]/[sourceSlug]` shape. The full page render lives at
 * `app/[orgSlug]/[sourceSlug]/page.tsx`.
 *
 * Schedule for deletion: once the API's bare `/v1/sources/:slug` path
 * starts returning 400 (the final piece of #698), this resolver call
 * breaks. Delete this whole route at the same time, or migrate the
 * resolution to a dedicated `/v1/lookups/source-by-slug` endpoint if we
 * want to keep redirecting legacy bookmarks longer.
 */
export default async function LegacySourceRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; path?: string; offset?: string }>;
}) {
  const { slug } = await params;
  const { tab, path, offset } = await searchParams;

  const resolved = await api.sourceLegacyResolve(slug);
  if (!resolved) notFound();

  const forward = new URLSearchParams();
  if (tab) forward.set("tab", tab);
  if (path) forward.set("path", path);
  if (offset) forward.set("offset", offset);
  const qs = forward.toString();
  redirect(`/${resolved.orgSlug}/${resolved.sourceSlug}${qs ? `?${qs}` : ""}`);
}
