import { OG_CONTENT_TYPE, OG_SIZE, type OgRenderOptions, renderOgImage } from "@/lib/og";

export const alt = "What's New on releases.sh";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 86400;

// `options` lets the unbounded `/updates/[date]` sibling (#2066, off the ISR
// path) forward its own Cache-Control through this shared card while this
// bounded top-level route keeps its own ISR revalidate above unchanged.
export default function Image(options?: OgRenderOptions) {
  return renderOgImage(
    {
      eyebrow: "Changelog",
      title: "What's New",
      description:
        "Product updates for releases.sh — new features, fixes, and improvements, rolled up by day.",
    },
    options,
  );
}
