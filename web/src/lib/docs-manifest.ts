import { loadDoc, type Doc } from "@/lib/docs";

export const SITE_NAME = "releases.sh";
export const SITE_TAGLINE = "The latest product releases, indexed for agents.";

export type DocEntry = {
  /** Path under `src/content/docs/`, e.g. `cli/browsing`. `index` is the `/docs` root. */
  slug: string;
  /** Canonical in-app URL, e.g. `/docs/cli/browsing` (or `/docs` for the index). */
  path: string;
  /** Raw-markdown URL for agents, e.g. `/docs/cli/browsing.md` (or `/docs.md`). */
  mdPath: string;
  /** Grouping label used by llms.txt and the sidebar. */
  section: string;
  /** Short link label (shorter than `title`; shown in nav/llms.txt). */
  label: string;
  /** From frontmatter. */
  title: string;
  description?: string;
  adminOnly: boolean;
};

type Seed = Pick<DocEntry, "slug" | "section" | "label">;

// Authoritative, ordered list of every docs page. Public + admin are both here;
// callers filter via `includeAdmin`. Order matches the sidebar at `docs-nav.tsx`.
const ENTRIES: readonly Seed[] = [
  { slug: "why", section: "Introduction", label: "Why" },

  { slug: "index", section: "Getting Started", label: "Overview" },
  { slug: "installation", section: "Getting Started", label: "Installation" },
  { slug: "skills", section: "Getting Started", label: "Skills" },
  { slug: "examples", section: "Getting Started", label: "Examples" },

  { slug: "listing", section: "For Owners", label: "Get Listed" },

  { slug: "integrations/slack", section: "Integrations", label: "Slack" },

  { slug: "cli/browsing", section: "CLI", label: "Browsing & Search" },

  { slug: "api/rest", section: "API", label: "REST API" },
  { slug: "api/errors", section: "API", label: "Errors" },
  { slug: "api/webhooks", section: "API", label: "Webhooks" },
  { slug: "api/mcp", section: "API", label: "MCP Server" },

  { slug: "privacy", section: "About", label: "Privacy & Telemetry" },

  { slug: "cli/fetching", section: "Admin CLI", label: "Fetching Releases" },
  { slug: "cli/admin", section: "Admin CLI", label: "Source Management" },
];

// Hydrate once per process. Route handlers run outside React's render context,
// so `cache()` inside `loadDoc` wouldn't dedupe across calls — module scope is
// the right granularity. Content is static at build time.
const DOCS_BY_SLUG: ReadonlyMap<string, Doc> = new Map(
  ENTRIES.map((s) => [s.slug, loadDoc(s.slug)]),
);

const ALL_ENTRIES: readonly DocEntry[] = ENTRIES.map((seed) => {
  const doc = DOCS_BY_SLUG.get(seed.slug)!;
  return {
    slug: seed.slug,
    section: seed.section,
    label: seed.label,
    path: seed.slug === "index" ? "/docs" : `/docs/${seed.slug}`,
    mdPath: seed.slug === "index" ? "/docs.md" : `/docs/${seed.slug}.md`,
    title: doc.frontmatter.title,
    description: doc.frontmatter.description,
    adminOnly: doc.frontmatter.adminOnly ?? false,
  };
});

export function docsManifest({ includeAdmin }: { includeAdmin: boolean }): readonly DocEntry[] {
  return includeAdmin ? ALL_ENTRIES : ALL_ENTRIES.filter((e) => !e.adminOnly);
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
