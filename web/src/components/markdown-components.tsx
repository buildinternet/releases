/* eslint-disable @typescript-eslint/no-explicit-any */
import { EXTERNAL_UGC_REL, isSafeHref, isSafeImgSrc } from "@/lib/sanitize";
import { FallbackPlainImage } from "./fallback-image";

interface MarkdownComponentOptions {
  imgClass?: string;
  videoClass?: string;
  /** When true, demote markdown headings by 2 levels (h1→h3, h2→h4, …, capped at
   *  h6). Use inside release cards so changelog headings sit below the card's
   *  own h2 in the page outline rather than colliding with page-level headings.
   *  HTML5's sectioning-content "scoped outline" is not implemented by any
   *  browser or crawler, so explicit demotion is the only fix. */
  demoteHeadings?: boolean;
}

const defaults: Required<MarkdownComponentOptions> = {
  imgClass: "my-2 max-h-80 object-contain",
  videoClass: "my-3 max-w-lg",
  demoteHeadings: false,
};

const HEADING_DEMOTION_MAP: Record<string, "h3" | "h4" | "h5" | "h6"> = {
  h1: "h3",
  h2: "h4",
  h3: "h5",
  h4: "h6",
  h5: "h6",
  h6: "h6",
};

function buildHeadingDemotions(): Record<string, any> {
  const demoted: Record<string, any> = {};
  for (const [from, to] of Object.entries(HEADING_DEMOTION_MAP)) {
    const Tag = to;
    demoted[from] = ({ children, node: _node, ...rest }: any) => <Tag {...rest}>{children}</Tag>;
  }
  return demoted;
}

/**
 * Build markdown component overrides for ReactMarkdown.
 * Handles safe image rendering and YouTube/Vimeo/Loom video embeds.
 */
export function createMarkdownComponents(opts: MarkdownComponentOptions = {}): Record<string, any> {
  const { imgClass, videoClass, demoteHeadings } = { ...defaults, ...opts };

  return {
    ...(demoteHeadings ? buildHeadingDemotions() : {}),
    img: (props: any) => {
      const src = props.src as string | undefined;
      if (!isSafeImgSrc(src)) return null;
      return (
        <FallbackPlainImage
          src={src!}
          alt={props.alt || ""}
          className={`rounded-md max-w-full h-auto ${imgClass}`}
        />
      );
    },
    a: (props: any) => {
      const href = props.href as string | undefined;
      const children = props.children;
      if (!isSafeHref(href)) return <>{children}</>;

      // YouTube embed
      const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?]+)/);
      if (ytMatch) {
        return (
          <div className={`aspect-video ${videoClass}`}>
            <iframe
              src={`https://www.youtube.com/embed/${ytMatch[1]}`}
              className="w-full h-full rounded-md"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              loading="lazy"
            />
          </div>
        );
      }

      // Vimeo embed
      const vimeoMatch = href.match(/vimeo\.com\/(\d+)/);
      if (vimeoMatch) {
        return (
          <div className={`aspect-video ${videoClass}`}>
            <iframe
              src={`https://player.vimeo.com/video/${vimeoMatch[1]}`}
              className="w-full h-full rounded-md"
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="lazy"
            />
          </div>
        );
      }

      // Loom embed
      const loomMatch = href.match(/loom\.com\/share\/([^?&]+)/);
      if (loomMatch) {
        return (
          <div className={`aspect-video ${videoClass}`}>
            <iframe
              src={`https://www.loom.com/embed/${loomMatch[1]}`}
              className="w-full h-full rounded-md"
              allowFullScreen
              loading="lazy"
            />
          </div>
        );
      }

      // Direct video file link (.mp4, .webm)
      if (/\.(mp4|webm)(\?.*)?$/i.test(href)) {
        return (
          <video
            src={href}
            controls
            preload="metadata"
            className={`rounded-md max-w-full ${videoClass}`}
          />
        );
      }

      return (
        <a href={href} target="_blank" rel={EXTERNAL_UGC_REL}>
          {children}
        </a>
      );
    },
  };
}

/** Default components for list/card views (compact embeds). Demotes headings
 *  so the release card's own h2 stays the highest level in its subtree. */
export const markdownComponents = createMarkdownComponents({ demoteHeadings: true });

/** Detail page components (larger embeds). */
export const detailMarkdownComponents = createMarkdownComponents({
  imgClass: "my-3",
  videoClass: "my-4 max-w-2xl",
});

/**
 * Collapsed variant that hides images and video embeds.
 * Used for truncated/preview views.
 */
export const collapsedMarkdownComponents: Record<string, any> = {
  ...createMarkdownComponents({ demoteHeadings: true }),
  img: () => null,
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (!isSafeHref(href)) return <>{children}</>;
    if (/youtube|vimeo|loom/i.test(href)) return <>{children}</>;
    if (/\.(mp4|webm)(\?.*)?$/i.test(href)) return null;
    return (
      <a href={href} target="_blank" rel={EXTERNAL_UGC_REL}>
        {children}
      </a>
    );
  },
};
