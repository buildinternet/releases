import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "What's New on Releases Index";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image() {
  return renderOgImage({
    eyebrow: "Changelog",
    title: "What's New",
    description:
      "Product updates for Releases Index — new features, fixes, and improvements, rolled up by day.",
  });
}
