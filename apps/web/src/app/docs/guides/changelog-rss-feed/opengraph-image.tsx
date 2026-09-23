import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Turn any changelog into an RSS feed";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Guide",
    title: "Turn any changelog into an RSS feed",
    subtitle: "Append .atom to any org, source, or collection page",
    description:
      "Get an Atom feed for any product's changelog — even ones that don't publish a feed. Free, no account.",
  });
}
