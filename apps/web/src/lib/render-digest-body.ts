/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { remarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { rehypeReleaseBody } from "@/lib/render-release-body";
import { isInternalHref } from "@/lib/sanitize";
import {
  createDigestAnchorSlugger,
  isHttpUrl,
  releaseIdFromPath,
} from "@releases/rendering/digest-sections";

/**
 * Server-only. Renders a weekly-digest body's markdown to an HTML string.
 *
 * The digest page is the one caller that needs more than the generic
 * concerns `renderBodyMarkdownToHtml` (in {@link file://./render-release-body.ts})
 * covers: heading anchors (so the "In this issue" reel and the covered-
 * releases index can deep-link into the body) and in-body `/release/<id>`
 * citation rewriting (upstream link in a new tab, or same-tab when there's no
 * upstream url — mirrors `releaseLinkTarget()`).
 *
 * Rather than bolting those onto the shared pipeline, this module drives its
 * own `unified` chain: the same remark stages, then the shared
 * `rehypeReleaseBody` (heading demotion pinned to `0`, image sanitizing, and
 * the DEFAULT link treatment — every non-fragment anchor gets
 * `target="_blank"` + the external-UGC rel), then a second rehype pass
 * ({@link rehypeDigestBody}) that layers the digest-only behavior on top:
 *
 * - Release-link anchors (`/release/rel_…`) get `data-release-id`; ones with
 *   an http(s) upstream url keep the base pass's new-tab/UGC treatment (just
 *   pointed at the upstream href), ones without lose it (stay same-tab).
 * - Other same-origin anchors (e.g. a pointer back at another collection)
 *   also lose the new-tab/UGC treatment — same-tab, author-controlled nav.
 * - Headings get an `id` derived from their text, but only at
 *   `headingIdLevel` (source level `3`, i.e. markdown `###`) — this keeps DOM
 *   ids in sync with `parseDigestSections` (`@releases/rendering/digest-sections`),
 *   which only slugs `###` sections. Because the base pass runs with
 *   `demoteHeadings: 0`, a heading's tag name here already equals its source
 *   level, so no separate "before demotion" bookkeeping is needed.
 *
 * Running as a second pass (rather than one combined transform) keeps this
 * module reusing the shared base transform instead of copying it.
 */

export type RenderDigestMarkdownOpts = {
  /** Release id → upstream url (or null) for this digest's covered releases. */
  releaseLinks: ReadonlyMap<string, string | null>;
};

/** Flattens a hast node's text content (used to derive heading ids). Mirrors
 *  `stripInlineMarkdown` in `@releases/rendering/digest-sections`, which
 *  produces the same plain text from the raw markdown heading so the parsed
 *  `sections[].anchor` matches the DOM id assigned here. */
function hastText(node: any): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Source heading level `parseDigestSections` slugs — keep in sync. */
const DIGEST_HEADING_ID_LEVEL = 3;

/**
 * Second rehype pass, run after `rehypeReleaseBody`: adds digest section
 * heading ids and rewrites/relaxes the base pass's link treatment for release
 * and other same-origin anchors. See the module doc above for the full
 * behavior contract.
 */
function rehypeDigestBody(opts: {
  headingIds: (text: string) => string;
  releaseLinks: ReadonlyMap<string, string | null>;
}) {
  const { headingIds, releaseLinks } = opts;
  return (tree: any) => {
    visit(tree, "element", (node: any) => {
      const tag = node.tagName as string;

      const heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        if (Number(heading[1]) === DIGEST_HEADING_ID_LEVEL) {
          const text = hastText(node).trim();
          if (text) node.properties = { ...node.properties, id: headingIds(text) };
        }
        return;
      }

      if (tag !== "a") return;
      const href = typeof node.properties?.href === "string" ? node.properties.href : undefined;
      if (!href) return;

      const releaseId = releaseIdFromPath(href);
      if (releaseId) {
        const upstream = (releaseLinks.get(releaseId) ?? "").trim();
        if (isHttpUrl(upstream)) {
          // Base pass already set target/rel; just point it upstream and tag it.
          node.properties = { ...node.properties, href: upstream, dataReleaseId: releaseId };
        } else {
          // No upstream: internal, same-tab — drop the base pass's target/rel.
          const { target: _target, rel: _rel, ...rest } = node.properties ?? {};
          node.properties = { ...rest, dataReleaseId: releaseId };
        }
        return;
      }

      // Other same-origin app paths (e.g. another collection) stay in-document
      // too — author-controlled markdown, not scraped/vendor content.
      if (isInternalHref(href)) {
        const { target: _target, rel: _rel, ...rest } = node.properties ?? {};
        node.properties = rest;
      }
    });
  };
}

/**
 * Render a digest body's markdown to HTML, always `demoteHeadings: 0` (a
 * digest page's h1 is outside the body) and `"full"` variant (sanitized
 * inline images kept).
 */
export function renderDigestMarkdownToHtml(
  content: string,
  opts: RenderDigestMarkdownOpts,
): string {
  return unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype)
    .use(rehypeReleaseBody, { variant: "full", demoteHeadings: 0 })
    .use(rehypeDigestBody, {
      headingIds: createDigestAnchorSlugger(),
      releaseLinks: opts.releaseLinks,
    })
    .use([rehypeShikiPlugin])
    .use(rehypeStringify)
    .processSync(content)
    .toString();
}
