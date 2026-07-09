// Org sources view shares the org's OG card. The opengraph-image convention
// binds to its own segment only, so wrap the parent org image generator (route
// config can't be re-exported, only declared locally). (#1646)
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
