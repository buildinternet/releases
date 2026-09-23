import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "How to find any product's changelog";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Guide",
    title: "How to find any product's changelog",
    subtitle: "URL patterns, feed discovery, GitHub, and the last-resort page",
    description:
      "A repeatable method for locating release notes anywhere they hide — or query an index that already did the hunting.",
  });
}
