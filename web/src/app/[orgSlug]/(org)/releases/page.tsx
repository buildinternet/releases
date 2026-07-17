import { permanentRedirect } from "next/navigation";
import { enableOnDemandIsr } from "@/lib/static-params";

// On-demand ISR segment config kept so the redirect route still participates
// in the same static-params / cache story as sibling org tabs.
export const revalidate = 900;
export const generateStaticParams = enableOnDemandIsr;

/**
 * Back-compat: Releases is now the bare org URL (`/:org`). Old bookmarks,
 * sitemap entries, and `?tab=releases` deep-links that land on `/:org/releases`
 * permanently redirect here so crawlers consolidate on the canonical path.
 */
export default async function OrgReleasesRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  permanentRedirect(`/${orgSlug}`);
}
