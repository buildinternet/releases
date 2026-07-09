// The org's OG card also represents its release-list view. The opengraph-image
// convention binds to its own segment only (not nested children), so this
// subpage reuses the parent org image generator. Route-config exports must be
// declared locally and the generator wrapped (not re-exported) — Next can't
// statically analyze route-segment config through an `export … from`. (#1646)
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og";
import orgOgImage from "../opengraph-image";

export const alt = "Organization on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066); the shared org generator this wraps already sets
// Cache-Control for the Vercel Edge Network.
export const dynamic = "force-dynamic";

export default function Image(ctx: { params: Promise<{ orgSlug: string }> }) {
  return orgOgImage(ctx);
}
