// Overview reuses the parent org OG card. Route-config exports must be
// declared locally and the generator wrapped (not re-exported) — Next can't
// statically analyze route-segment config through an `export … from`. (#1646)
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og";
import orgOgImage from "../opengraph-image";

export const alt = "Organization on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image(ctx: { params: Promise<{ orgSlug: string }> }) {
  return orgOgImage(ctx);
}
