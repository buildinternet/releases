import fs from "node:fs";
import path from "node:path";
import { CONTENT_ROOT, loadDoc, type Doc } from "@/lib/docs";

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
const SEEDS = parseMetaPages(readMeta().pages);

const DOCS_BY_SLUG: ReadonlyMap<string, Doc> = new Map(SEEDS.map((s) => [s.slug, loadDoc(s.slug)]));

const ALL_ENTRIES: readonly DocEntry[] = SEEDS.map(({ slug, section }) => {
  const { frontmatter } = DOCS_BY_SLUG.get(slug)!;
  return {
    slug,
    section,
    label: frontmatter.label ?? frontmatter.title,
    path: slug === "index" ? "/docs" : `/docs/${slug}`,
    mdPath: slug === "index" ? "/docs.md" : `/docs/${slug}.md`,
    title: frontmatter.title,
    description: frontmatter.description,
    adminOnly: frontmatter.adminOnly ?? false,
  };
});

export function docsManifest({ includeAdmin }: { includeAdmin: boolean }): readonly DocEntry[] {
  return includeAdmin ? ALL_ENTRIES : ALL_ENTRIES.filter((e) => !e.adminOnly);
}

/** The preloaded `Doc` for a listed slug, or `undefined` if meta.json doesn't list it. */
export function findLoadedDoc(slug: string): Doc | undefined {
  return DOCS_BY_SLUG.get(slug);
}

/** Access the preloaded `Doc` for an entry so callers don't re-read the file. */
export function getLoadedDoc(slug: string): Doc {
  const doc = DOCS_BY_SLUG.get(slug);
  if (!doc) throw new Error(`docs-manifest: unknown slug "${slug}"`);
  return doc;
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
