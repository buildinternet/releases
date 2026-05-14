import ReactMarkdown from "react-markdown";
import { createRemarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { FallbackImage } from "@/components/fallback-image";

interface MediaItem {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Url?: string;
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
