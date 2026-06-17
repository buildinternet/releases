// Changelog view shares the source OG card. The opengraph-image convention
// binds to its own segment only, so wrap the parent generator (route config
// can't be re-exported, only declared locally). (#1646)
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og";
import sourceOgImage from "../opengraph-image";

export const alt = "Source on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image(ctx: { params: Promise<{ id: string }> }) {
  return sourceOgImage(ctx);
}
