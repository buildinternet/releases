import { OG_CONTENT_TYPE, OG_SIZE, renderOgFallback, renderOgImage } from "@/lib/og";
import { buildOrgOgProps } from "@/lib/org-og-card";

export const alt = "Organization on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default async function Image({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  try {
    const props = await buildOrgOgProps(orgSlug);
    return renderOgImage(props);
  } catch {
    return renderOgFallback();
  }
}
