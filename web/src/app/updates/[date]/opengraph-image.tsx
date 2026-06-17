// A day's updates share the "What's New" OG card. The opengraph-image
// convention binds to its own segment only, so wrap the parent generator
// (route config can't be re-exported, only declared locally). (#1646)
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og";
import updatesOgImage from "../opengraph-image";

export const alt = "What's New on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image() {
  return updatesOgImage();
}
