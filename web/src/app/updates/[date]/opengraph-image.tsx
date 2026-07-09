// A day's updates share the "What's New" OG card. The opengraph-image
// convention binds to its own segment only, so wrap the parent generator
// (route config can't be re-exported, only declared locally). (#1646)
import { OG_CDN_CACHE_HEADERS, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og";
import updatesOgImage from "../opengraph-image";

export const alt = "What's New on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Off the ISR path (#2066): unbounded `[date]` cardinality means every render
// is a write and almost never a read. Cached by Vercel's Edge Network via
// OG_CDN_CACHE_HEADERS instead.
export const dynamic = "force-dynamic";

export default function Image() {
  return updatesOgImage({ headers: OG_CDN_CACHE_HEADERS });
}
