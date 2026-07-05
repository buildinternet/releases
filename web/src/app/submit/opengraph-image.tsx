import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og";

export const alt = "Submit your product — releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

export default function Image() {
  return renderOgImage({
    eyebrow: "Open Catalog",
    title: "Submit Your Product",
    description:
      "Add your product with a releases.json manifest or a release notes URL.",
  });
}
