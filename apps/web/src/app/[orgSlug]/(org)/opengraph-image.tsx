import { OG_CONTENT_TYPE, OG_SIZE, renderOgFallback, renderOgImage } from "@/lib/og";
import { buildOrgOgProps } from "@/lib/org-og-card";
import { enableOnDemandIsr } from "@/lib/static-params";

export const alt = "Organization on Release Notes Index";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;
export const generateStaticParams = enableOnDemandIsr;

export default async function Image({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  try {
    const props = await buildOrgOgProps(orgSlug);
    return renderOgImage(props);
  } catch {
    return renderOgFallback();
  }
}
