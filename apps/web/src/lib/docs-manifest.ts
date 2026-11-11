import fs from "node:fs";
import path from "node:path";
import { CONTENT_ROOT, docMdPath, docPath, loadDoc, type Doc } from "@/lib/docs";

export const SITE_NAME = "Release Notes Index";
export const SITE_TAGLINE = "The latest product releases, indexed for agents.";

export type DocEntry = {
  /** Path under `src/content/docs/`, e.g. `cli/browsing`. `index` is the `/docs` root. */
  slug: string;
  /** Canonical in-app URL, e.g. `/docs/cli/browsing` (or `/docs` for the index). */
  path: string;
  /** Raw-markdown URL for agents, e.g. `/docs/cli/browsing.md` (or `/docs.md`). */
  mdPath: string;
  /** Grouping label used by llms.txt and the sidebar (a `---Section---` in meta.json). */
  section: string;
  /** Short link label: frontmatter `label`, else `title`. */
  label: string;
  title: string;
  description?: string;
  adminOnly: boolean;
  /** The page's frontmatter and MDX source, loaded once per process. */
  doc: Doc;
};

/**
 * Sidebar order lives in `src/content/docs/meta.json`, in Fumadocs' page
 * convention: `---Section---` separators followed by page paths (`index`,
 * `./cli/browsing`). Fumadocs reads the same file for its page tree; this
 * reader exists so the sitemap, llms.txt and tests get the order without
 * importing compiled MDX.
 */
type Meta = { pages: string[] };

const SEPARATOR = /^---(.+)---$/;

export function parseMetaPages(pages: readonly string[]): Array<{ slug: string; section: string }> {
  const out: Array<{ slug: string; section: string }> = [];
  let section = "";
  for (const item of pages) {
    const sep = item.match(SEPARATOR);
    if (sep) {
      section = sep[1].trim();
      continue;
    }
    if (item.startsWith("!") || item.startsWith("...") || item.startsWith("[")) {
      throw new Error(`docs meta.json: unsupported item "${item}" (list each page explicitly)`);
    }
    out.push({ slug: item.replace(/^\.\//, ""), section });
  }
  return out;
}

function readMeta(): Meta {
  return JSON.parse(fs.readFileSync(path.join(CONTENT_ROOT, "docs", "meta.json"), "utf8")) as Meta;
}

// Hydrate once per process. Route handlers run outside React's render context,
// so `cache()` inside `loadDoc` wouldn't dedupe across calls — module scope is
// the right granularity. Content is static at build time.
const ALL_ENTRIES: readonly DocEntry[] = parseMetaPages(readMeta().pages).map(
  ({ slug, section }) => {
    const doc = loadDoc(slug);
    const { frontmatter } = doc;
    return {
      slug,
      section,
      label: frontmatter.label ?? frontmatter.title,
      path: docPath(slug),
      mdPath: docMdPath(slug),
      title: frontmatter.title,
      description: frontmatter.description,
      adminOnly: frontmatter.adminOnly ?? false,
      doc,
    };
  },
);

const ENTRIES_BY_SLUG: ReadonlyMap<string, DocEntry> = new Map(ALL_ENTRIES.map((e) => [e.slug, e]));

export function docsManifest({ includeAdmin }: { includeAdmin: boolean }): readonly DocEntry[] {
  return includeAdmin ? ALL_ENTRIES : ALL_ENTRIES.filter((e) => !e.adminOnly);
}

/**
 * The docs page at `slug` if it is listed in meta.json and visible (admin-only
 * pages need `includeAdmin`), else `undefined`. The one visibility rule every
 * docs route uses.
 */
export function findVisibleDoc(
  slug: string,
  { includeAdmin }: { includeAdmin: boolean },
): Doc | undefined {
  const entry = ENTRIES_BY_SLUG.get(slug);
  return entry && (includeAdmin || !entry.adminOnly) ? entry.doc : undefined;
}

/** Group manifest entries by `section`, preserving insertion order. */
export function groupBySection(
  entries: readonly DocEntry[],
): Array<{ section: string; items: DocEntry[] }> {
  const order: string[] = [];
  const buckets = new Map<string, DocEntry[]>();
  for (const e of entries) {
    if (!buckets.has(e.section)) {
      buckets.set(e.section, []);
      order.push(e.section);
    }
    buckets.get(e.section)!.push(e);
  }
  return order.map((section) => ({ section, items: buckets.get(section)! }));
}
