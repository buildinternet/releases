import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Why Releases — changelog infrastructure built for agents";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Why Releases",
    title: "Changelog infrastructure built for agents",
    subtitle: "The Context7-equivalent for what shipped",
    description:
      "One registry across GitHub releases, CHANGELOG files, marketing blogs, RSS, and more.",
  });
}
