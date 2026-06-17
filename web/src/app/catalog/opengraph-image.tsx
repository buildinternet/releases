import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Catalog — releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image() {
  return renderOgImage({
    eyebrow: "Catalog",
    title: "Every tracked organization",
    description:
      "Browse the full registry of companies whose changelogs and release notes we index.",
  });
}
