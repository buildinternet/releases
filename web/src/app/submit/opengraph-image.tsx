import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Submit a source — releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image() {
  return renderOgImage({
    eyebrow: "Open Catalog",
    title: "Submit a release source",
    description:
      "Recommend a changelog, release notes page, feed, or GitHub releases URL for the registry.",
  });
}
