import { notFound, permanentRedirect } from "next/navigation";
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

  // Resolve the legacy `?tab=` shape to the new path-based tabs in one hop so
  // bookmarks don't bounce through two redirects (#875).
  const subpath = tab === "highlights" ? "/highlights" : tab === "changelog" ? "/changelog" : "";
  const forward = new URLSearchParams();
  if (path) forward.set("path", path);
  if (offset) forward.set("offset", offset);
  const qs = forward.toString();
  permanentRedirect(`/${resolved.orgSlug}/${resolved.sourceSlug}${subpath}${qs ? `?${qs}` : ""}`);
}
