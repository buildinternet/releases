/* eslint-disable @typescript-eslint/no-explicit-any */
import ReactMarkdown from "react-markdown";
import { canonicalVideoFromUrl } from "@releases/rendering/video-embed";
import { rewriteRelativeLinks, originFromUrl } from "@releases/rendering/rewrite-links";
import { createRemarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { FallbackImage } from "@/components/fallback-image";
import { PlayBadge } from "@/components/play-badge";
import { releaseThumbUrl, IMG_TRANSFORM_ON } from "@/lib/media";

export interface MediaItem {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Url?: string;
  /** Watch URL for a hosted-video card (#1549); present on `type: "video"`. */
  linkUrl?: string;
}

/**
 * Match a body anchor `href` to a stored `type:"video"` media item by canonical
 * video id. The href and each media item's `linkUrl`/`url` are normalized
 * through `canonicalVideoFromUrl`, so matching is id-based — a row whose stored
 * `linkUrl` predates a `watchUrl` change (e.g. the old Wistia `medias/<id>`
 * form) still matches the new embed-form href in the body. Returns null when the
 * href isn't a recognised video URL or no stored video item shares its id.
 */
export function matchVideoMedia(href: string, media: MediaItem[]): MediaItem | null {
  const target = canonicalVideoFromUrl(href);
  if (!target) return null;
  for (const item of media) {
    if (item.type !== "video") continue;
    const candidate =
      (item.linkUrl ? canonicalVideoFromUrl(item.linkUrl) : null) ??
      canonicalVideoFromUrl(item.url);
    if (candidate && candidate.provider === target.provider && candidate.id === target.id) {
      return item;
    }
  }
  return null;
}

/**
 * Read-only play-thumbnail card for a hosted video promoted from an inline body
 * link (#1549). Links out to the provider's watch page (`linkUrl`) — no iframe
 * embed yet (deferred: CSP / third-party-JS surface). The poster is the
 * R2-mirrored oEmbed thumbnail.
 */
function InlineVideoCard({ poster, href, alt }: { poster: string; href: string; alt?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={alt ? `Watch video: ${alt}` : "Watch video"}
      className="group relative block aspect-video w-full max-w-xl overflow-hidden rounded-lg border border-stone-200 bg-black no-underline dark:border-stone-800"
    >
      <FallbackImage
        src={releaseThumbUrl(poster, 1280)}
        alt={alt || ""}
        width={1280}
        height={720}
        className="h-full w-full object-cover"
        unoptimized={IMG_TRANSFORM_ON || undefined}
      />
      <PlayBadge />
      {alt && (
        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 text-sm font-medium text-white">
          {alt}
        </span>
      )}
    </a>
  );
}

function stripLeadingTitle(content: string, title: string | null): string {
  if (!title || !content) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const firstLine = content
    .slice(0, firstNewline)
    .replace(/^#+\s+/, "")
    .trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) {
    content = content.slice(firstNewline + 1).trimStart();
  }
  // Strip empty markdown artifacts left by HTML-to-markdown conversion
  // (orphan list items, empty headings, bare bullets)
  content = content.replace(/^(?:-\s*\n|#+\s*\n)+/, "");
  return content;
}

export function MediaGallery({ media, content }: { media: MediaItem[]; content: string }) {
  if (!media || media.length === 0) return null;
  // `type:"video"` items are always promoted from an inline body link, so they
  // render inline (in place of that link, via the `a` renderer) and must not
  // also appear here — otherwise the card duplicates, and the gallery card uses
  // the synthesized watch URL (the old, login-redirecting Wistia form for
  // already-backfilled rows) rather than the known-loadable body href.
  const extra = media.filter(
    (m) =>
      m.type !== "video" && !content.includes(m.url) && !(m.r2Url && content.includes(m.r2Url)),
  );
  if (extra.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-4">
      {extra.map((item, i) => {
        if (item.type === "image" || item.type === "gif") {
          const src = item.r2Url ?? item.url;
          return (
            <FallbackImage
              key={i}
              src={src}
              alt={item.alt || ""}
              width={600}
              height={320}
              className="rounded-md object-contain max-h-80 w-auto"
            />
          );
        }
        return null;
      })}
    </div>
  );
}

/**
 * Build the detail markdown components, overriding the `a` renderer so a body
 * link to a hosted video renders the {@link InlineVideoCard} in place — but only
 * when a matching `type:"video"` media item (with a poster) exists. The card
 * links to the ORIGINAL body href (known-loadable) and uses the matched item's
 * mirrored poster. Fail-open: any non-matching link (or a matched item without a
 * poster) delegates to the base `a` renderer, so existing iframe-embed handling
 * for YouTube/Vimeo/Loom and plain links are unchanged.
 */
export function buildDetailComponents(media: MediaItem[]): Record<string, any> {
  const baseAnchor = detailMarkdownComponents.a as (props: any) => any;
  return {
    ...detailMarkdownComponents,
    a: (props: any) => {
      const href = props.href as string | undefined;
      if (typeof href === "string") {
        const item = matchVideoMedia(href, media);
        const poster = item ? (item.r2Url ?? item.url) : undefined;
        if (item && poster) {
          return <InlineVideoCard poster={poster} href={href} alt={item.alt} />;
        }
      }
      return baseAnchor(props);
    },
  };
}

export function ReleaseContent({
  content,
  title,
  media,
  repoUrl,
  sourceUrl,
}: {
  content: string;
  title: string;
  media: MediaItem[];
  repoUrl?: string | null;
  /** Canonical URL of the release (e.g. `release.url`). Its origin is used to
   *  absolutize root-relative links in the body so they resolve to the vendor's
   *  domain rather than releases.sh. */
  sourceUrl?: string | null;
}) {
  const base = originFromUrl(sourceUrl);
  const rawContent = stripLeadingTitle(content, title);
  const markdownContent = base ? rewriteRelativeLinks(rawContent, base) : rawContent;
  const remarkPlugins = createRemarkPlugins({ repoUrl });
  const components = buildDetailComponents(media);

  return (
    <div className="prose prose-stone dark:prose-invert max-w-none text-[15px] leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_ul]:my-2 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-2 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-sm [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeShikiPlugin]}
        components={components}
      >
        {markdownContent}
      </ReactMarkdown>
      <MediaGallery media={media} content={markdownContent} />
    </div>
  );
}
