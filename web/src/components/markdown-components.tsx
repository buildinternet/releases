/* eslint-disable @typescript-eslint/no-explicit-any */
import { EXTERNAL_UGC_REL, isFragmentHref, isSafeHref, isSafeImgSrc } from "@/lib/sanitize";
import { HeadingAnchor } from "./heading-anchor";
import { youtubeEmbedUrl, youtubeVideoId } from "@/lib/video-source";
import { MEDIA_VIDEO_ON, shouldRenderAsVideo } from "@/lib/media";
import { FallbackPlainImage } from "./fallback-image";
import { GifVideo } from "./gif-video";

interface MarkdownComponentOptions {
  imgClass?: string;
  videoClass?: string;
  /** Levels to demote markdown headings by (capped at h6); `0` leaves them as-is.
   *  Body content must never out-rank the heading that owns it in the page
   *  outline: release *cards* carry their own h2, so card bodies demote by `2`
   *  (h1→h3); the release *detail* page's title is the page h1, so its body
   *  demotes by `1` (h1→h2) to keep exactly one h1 per page. HTML5's
   *  sectioning-content "scoped outline" is implemented by no browser or
   *  crawler, so explicit demotion is the only fix. */
  demoteHeadings?: 0 | 1 | 2;
  /** Render a hover-revealed anchor link beside h2–h4 headings, using the `id`
   *  that `rehype-slug` stamps on each heading. Docs pages only — release/card
   *  bodies don't run `rehype-slug`, so their headings have no ids to link to
   *  and enabling this would just add empty affordances. */
  headingAnchors?: boolean;
}

const defaults: Required<MarkdownComponentOptions> = {
  imgClass: "my-2 max-h-80 object-contain",
  videoClass: "my-3 max-w-lg",
  demoteHeadings: 0,
  headingAnchors: false,
};

/** h2–h4 overrides that keep the `rehype-slug` id and append a `HeadingAnchor`.
 *  h1 (page title) and h5/h6 (too deep to deep-link in practice) pass through. */
function buildHeadingAnchors(): Record<string, any> {
  const anchored: Record<string, any> = {};
  for (const level of [2, 3, 4] as const) {
    const Tag = `h${level}`;
    anchored[Tag] = ({ children, node: _node, id, ...rest }: any) => (
      <Tag id={id} className="group scroll-mt-24" {...rest}>
        {children}
        {id ? <HeadingAnchor id={id} /> : null}
      </Tag>
    );
  }
  return anchored;
}

function buildHeadingDemotions(by: 1 | 2): Record<string, any> {
  const demoted: Record<string, any> = {};
  for (let level = 1; level <= 6; level++) {
    const Tag = `h${Math.min(level + by, 6)}`;
    demoted[`h${level}`] = ({ children, node: _node, ...rest }: any) => (
      <Tag {...rest}>{children}</Tag>
    );
  }
  return demoted;
}

/**
 * Build markdown component overrides for ReactMarkdown.
 * Handles safe image rendering and YouTube/Vimeo/Loom video embeds.
 */
export function createMarkdownComponents(opts: MarkdownComponentOptions = {}): Record<string, any> {
  const { imgClass, videoClass, demoteHeadings, headingAnchors } = { ...defaults, ...opts };

  return {
    ...(demoteHeadings ? buildHeadingDemotions(demoteHeadings) : {}),
    ...(headingAnchors ? buildHeadingAnchors() : {}),
    img: (props: any) => {
      const src = props.src as string | undefined;
      if (!isSafeImgSrc(src)) return null;
      const className = `rounded-md outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 max-w-full h-auto ${imgClass}`;
      // Heavy animated GIFs render as a Media Transformations MP4 <video> (same
      // decision the gallery/lightbox use), keyed off the `.gif` pathname so
      // both `/_media/`-hydrated R2 URLs and third-party sources are covered.
      // The shared className keeps the <video> at the inline <img>'s width and
      // rounding inside the prose container. GifVideo carries its own <img>
      // fallback on transform error.
      if (shouldRenderAsVideo({ src: src!, enabled: MEDIA_VIDEO_ON })) {
        return <GifVideo src={src!} alt={props.alt || ""} className={className} />;
      }
      return <FallbackPlainImage src={src!} alt={props.alt || ""} className={className} />;
    },
    a: (props: any) => {
      const href = props.href as string | undefined;
      const children = props.children;
      if (!isSafeHref(href)) return <>{children}</>;

      // Same-page fragment link (heading anchor / TOC target). Stays in-document,
      // so no `target="_blank"` and no external-UGC rel.
      if (isFragmentHref(href)) {
        return <a href={href}>{children}</a>;
      }

      // YouTube embed. Shared id regex + `youtube-nocookie` host (see
      // @/lib/video-source); `autoplay: false` because this iframe renders
      // inline in body copy rather than behind the detail page's click-to-play
      // facade, so it must not start playing on load.
      const ytId = youtubeVideoId(href);
      if (ytId) {
        return (
          <div className={`aspect-video ${videoClass}`}>
            <iframe
              src={youtubeEmbedUrl(ytId, { autoplay: false })}
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
export const markdownComponents = createMarkdownComponents({ demoteHeadings: 2 });

/** Detail page components (larger embeds). */
export const detailMarkdownComponents = createMarkdownComponents({
  imgClass: "my-3",
  videoClass: "my-4 max-w-2xl",
  // The detail page renders the release title as the page's single <h1>; demote
  // body headings by one so changelog `#`/`##` headings start at h2 and don't
  // create extra h1s.
  demoteHeadings: 1,
});

/** Docs / static-page components (larger embeds, headings un-demoted).
 *  Unlike the release detail page, a docs/legal page has NO separately-rendered
 *  page title — the markdown body's leading `# Title` IS the page's single <h1>.
 *  Demoting here would strip the only h1 from the page (Ahrefs "H1 missing",
 *  June 2026). Each doc body carries exactly one top-level `#`. */
export const docMarkdownComponents = createMarkdownComponents({
  imgClass: "my-3",
  videoClass: "my-4 max-w-2xl",
  demoteHeadings: 0,
  // Docs run `rehype-slug` (see MarkdownDoc), so their headings carry stable
  // ids — render the hover anchor affordance so sections are grab-able.
  headingAnchors: true,
});

/**
 * Collapsed variant that hides images and video embeds.
 * Used for truncated/preview views.
 */
export const collapsedMarkdownComponents: Record<string, any> = {
  ...createMarkdownComponents({ demoteHeadings: 2 }),
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
