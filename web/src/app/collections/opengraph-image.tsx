import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Collections on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const dynamic = "force-static";

export default function Image() {
  return renderOgImage({
    eyebrow: "Collections",
    title: "Curated playlists",
    subtitle: "Group changelogs by theme",
    description:
      "Follow a market or topic in one place — releases from every org in the collection, interleaved into a single feed.",
  });
}
