/* eslint-disable @typescript-eslint/no-explicit-any */
import { isSafeHref, isSafeImgSrc } from "@/lib/sanitize";

interface MarkdownComponentOptions {
  imgClass?: string;
  videoClass?: string;
}

const defaults: Required<MarkdownComponentOptions> = {
  imgClass: "my-2 max-h-80 object-contain",
  videoClass: "my-3 max-w-lg",
};

/**
 * Build markdown component overrides for ReactMarkdown.
 * Handles safe image rendering and YouTube/Vimeo/Loom video embeds.
 */
export function createMarkdownComponents(
  opts: MarkdownComponentOptions = {}
): Record<string, any> {
  const { imgClass, videoClass } = { ...defaults, ...opts };

  return {
    img: (props: any) => {
      const src = props.src as string | undefined;
      if (!isSafeImgSrc(src)) return null;
      return (
        <img
          src={src}
          alt={props.alt || ""}
          loading="lazy"
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

      // Regular link
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
}

/** Default components for list/card views (compact embeds). */
export const markdownComponents = createMarkdownComponents();

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
  img: () => null,
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (!isSafeHref(href)) return <>{children}</>;
    if (/youtube|vimeo|loom/i.test(href)) return <>{children}</>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
};
