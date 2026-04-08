/* eslint-disable @typescript-eslint/no-explicit-any */
import { isSafeHref, isSafeImgSrc } from "@/lib/sanitize";

/**
 * Shared markdown component overrides for ReactMarkdown.
 * Handles safe image rendering and YouTube/Vimeo/Loom video embeds.
 */
export const markdownComponents: Record<string, any> = {
  img: (props: any) => {
    const src = props.src as string | undefined;
    if (!isSafeImgSrc(src)) return null;
    return (
      <img
        src={src}
        alt={props.alt || ""}
        loading="lazy"
        className="rounded-md max-w-full h-auto my-2 max-h-80 object-contain"
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
        <div className="my-3 aspect-video max-w-lg">
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
        <div className="my-3 aspect-video max-w-lg">
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
        <div className="my-3 aspect-video max-w-lg">
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

/**
 * Collapsed variant that hides images and video embeds.
 * Used for truncated/preview views.
 */
export const collapsedMarkdownComponents: Record<string, any> = {
  ...markdownComponents,
  img: () => null,
  a: (props: any) => {
    const href = props.href as string | undefined;
    const children = props.children;
    if (!isSafeHref(href)) return <>{children}</>;
    if (/youtube|vimeo|loom/i.test(href)) return <>{children}</>;
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
};
