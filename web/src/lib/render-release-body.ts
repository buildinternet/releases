/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { visit, SKIP } from "unist-util-visit";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { releaseExcerpt } from "@/lib/release-excerpt";
import { rewriteRelativeLinks, originFromUrl } from "@releases/rendering/rewrite-links";
import { EXTERNAL_UGC_REL, isSafeHref, isSafeImgSrc } from "@/lib/sanitize";
import type { WithBodyHtml } from "@/lib/release-view";

/**
 * Server-only. Renders a release's excerpt markdown to an HTML string.
 *
 * `ReleaseListItem` used to run `react-markdown` + remark + shiki on the client,
 * dragging those libraries into the bundle of every content-heavy list route.
 * We now render on the server (initial page render + the pagination route
 * handlers) and inject the result via `dangerouslySetInnerHTML`, so the heavy
 * markdown pipeline stays server-side.
 *
 * Next's App Router forbids importing `react-dom/server`, so instead of
 * stringifying `<ReactMarkdown>` we drive the same `unified` pipeline directly
 * to an HTML string (`remark-parse` → the shared `remarkPlugins` → `remark-rehype`
 * → shiki → `rehype-stringify`). react-markdown's only element customizations
 * were `img` / `a` / heading demotion, reproduced by {@link rehypeReleaseBody}
 * below; everything else (GFM, GitHub alerts/refs, gemoji, code→shiki) is
 * plugin-driven and stringifies identically. `remark-rehype` drops raw HTML by
 * default (no `allowDangerousHtml`), matching react-markdown's default — the
 * output is the same *sanitized* markup, so `dangerouslySetInnerHTML` adds no
 * injection surface.
 *
 * Behavior delta (documented, intentional): inline YouTube/Vimeo/Loom iframe and
 * `.mp4` video embeds — which `markdownComponents` rendered inside a body — are
 * emitted as plain links here. These only mattered for the ≤280-char feed
 * excerpt of an App Store / video row; the collapsed variant already stripped
 * them, and full inline embeds belong to the canonical `/release/{id}` page.
 *
 * The `"server-only"` import makes any accidental client import a build error —
 * the point being to keep this module (and thus shiki + the unified stack) out
 * of the browser bundle.
 */

/** `"full"` keeps sanitized inline images (App Store / video rows whose expanded
 *  body shows media); `"collapsed"` strips images (the standard card body). Row
 *  variant follows the source kind, known wherever the release data is produced. */
export type BodyVariant = "full" | "collapsed";

export type BodyRenderable = {
  content?: string | null;
  summary?: string | null;
  title?: string | null;
  url?: string | null;
};

// Mirrors markdownComponents' list/card image class (createMarkdownComponents
// default `imgClass`), so a full-variant inline image reads the same as before.
const IMG_CLASS =
  "rounded-md outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10 max-w-full h-auto my-2 max-h-80 object-contain";

/**
 * rehype transform reproducing the `markdownComponents` element overrides:
 * demote headings by 2 (release cards own their h2), sanitize/strip images per
 * variant, and unwrap unsafe links while marking safe ones as external UGC.
 */
function rehypeReleaseBody(variant: BodyVariant) {
  return (tree: any) => {
    visit(tree, "element", (node: any, index: any, parent: any) => {
      const tag = node.tagName as string;

      const heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        node.tagName = `h${Math.min(Number(heading[1]) + 2, 6)}`;
        return;
      }

      if (!parent || typeof index !== "number") return;

      if (tag === "img") {
        const src = typeof node.properties?.src === "string" ? node.properties.src : undefined;
        if (variant === "collapsed" || !isSafeImgSrc(src)) {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
        node.properties = { ...node.properties, className: IMG_CLASS };
        return;
      }

      if (tag === "a") {
        const href = typeof node.properties?.href === "string" ? node.properties.href : undefined;
        if (!isSafeHref(href)) {
          // Unwrap the unsafe anchor to its children (drops the href, keeps text).
          parent.children.splice(index, 1, ...node.children);
          return index;
        }
        node.properties = { ...node.properties, target: "_blank", rel: EXTERNAL_UGC_REL };
        return;
      }
    });
  };
}

function renderToHtml(content: string, variant: BodyVariant): string {
  return unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype)
    .use(rehypeReleaseBody, variant)
    .use([rehypeShikiPlugin])
    .use(rehypeStringify)
    .processSync(content)
    .toString();
}

/**
 * Row variant for a mixed org/product feed: App Store and video rows show an
 * expanded body with inline media (`"full"`); everything else uses the
 * always-visible collapsed body (`"collapsed"`). Follows the source kind, which
 * the org feed carries per release on `source.appStore` / `source.video`.
 */
export function orgRowVariant(
  release: BodyRenderable & { source?: { appStore?: unknown; video?: unknown } | null },
): BodyVariant {
  return release.source?.appStore || release.source?.video ? "full" : "collapsed";
}

/** Render one release's excerpt to HTML. Empty (no notes) → `""`. */
export function renderReleaseBodyHtml(release: BodyRenderable, variant: BodyVariant): string {
  const raw = releaseExcerpt(release);
  const base = originFromUrl(release.url);
  const content = base ? rewriteRelativeLinks(raw, base) : raw;
  if (!content.trim()) return "";
  return renderToHtml(content, variant);
}

/**
 * Render one release's FULL body (not the capped excerpt) to HTML, always with
 * the `"full"` variant (sanitized inline images kept). Backs the lazy
 * `/api/release-body/[id]` endpoint that `collection-timeline`'s "Show more"
 * fetches — so the verbatim body reaches the DOM only on an explicit user
 * expand, never in the initial crawlable HTML (#1606), and shiki stays off the
 * client. Empty (no notes) → `""`.
 */
export function renderReleaseFullBodyHtml(release: BodyRenderable): string {
  const raw = release.content || release.summary || "";
  const base = originFromUrl(release.url);
  const content = base ? rewriteRelativeLinks(raw, base) : raw;
  if (!content.trim()) return "";
  return renderToHtml(content, "full");
}

/**
 * Attach `bodyHtml` to each release. `variant` is either a fixed variant (source
 * lists, where every row shares the source's kind) or a per-release function
 * (mixed org/product feeds, deciding from `release.source`).
 */
export function withReleaseBodyHtml<T extends BodyRenderable>(
  releases: T[],
  variant: BodyVariant | ((release: T) => BodyVariant),
): WithBodyHtml<T>[] {
  const pick = typeof variant === "function" ? variant : () => variant;
  return releases.map((release) => ({
    ...release,
    bodyHtml: renderReleaseBodyHtml(release, pick(release)),
  }));
}
