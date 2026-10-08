import { buildCollectionOgProps } from "@/lib/collection-og-card";
import { OG_CONTENT_TYPE, OG_SIZE, renderOgFallback, renderOgImage } from "@/lib/og";
import { enableOnDemandIsr } from "@/lib/static-params";

export const alt = "Collection on Release Notes Index";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;
export const generateStaticParams = enableOnDemandIsr;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return renderOgImage(await buildCollectionOgProps(slug));
  } catch {
    return renderOgFallback();
  }
}
