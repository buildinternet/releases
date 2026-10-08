import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";
import { SITE_OG_ALT, SITE_OG_PROPS } from "@/lib/site-og-card";

export const alt = SITE_OG_ALT;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage(SITE_OG_PROPS);
}
