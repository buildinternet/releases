import ReactMarkdown from "react-markdown";
import { createRemarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { FallbackImage } from "@/components/fallback-image";
import { PlayBadge } from "@/components/play-badge";
import { releaseThumbUrl, IMG_TRANSFORM_ON } from "@/lib/media";

interface MediaItem {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Url?: string;
  /** Watch URL for a hosted-video card (#1549); present on `type: "video"`. */
  linkUrl?: string;
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

function MediaGallery({ media, content }: { media: MediaItem[]; content: string }) {
  if (!media || media.length === 0) return null;
  const extra = media.filter(
    (m) => !content.includes(m.url) && !(m.r2Url && content.includes(m.r2Url)),
  );
  if (extra.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-4">
      {extra.map((item, i) => {
        if (item.type === "video" && item.linkUrl) {
          return (
            <InlineVideoCard
              key={i}
              poster={item.r2Url ?? item.url}
              href={item.linkUrl}
              alt={item.alt}
            />
          );
        }
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

export function ReleaseContent({
  content,
  title,
  media,
  repoUrl,
}: {
  content: string;
  title: string;
  media: MediaItem[];
  repoUrl?: string | null;
}) {
  const markdownContent = stripLeadingTitle(content, title);
  const remarkPlugins = createRemarkPlugins({ repoUrl });

  return (
    <div className="prose prose-stone dark:prose-invert max-w-none text-[15px] leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_ul]:my-2 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-2 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_a]:no-underline [&_code]:text-sm [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeShikiPlugin]}
        components={detailMarkdownComponents}
      >
        {markdownContent}
      </ReactMarkdown>
      <MediaGallery media={media} content={markdownContent} />
    </div>
  );
}
