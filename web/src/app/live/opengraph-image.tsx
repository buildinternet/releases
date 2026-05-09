import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Live releases on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Live",
    title: "Live releases",
    subtitle: "Watch new changelog entries arrive in real time",
    description:
      "A live feed of product releases as they're fetched and indexed across every tracked source.",
  });
}
