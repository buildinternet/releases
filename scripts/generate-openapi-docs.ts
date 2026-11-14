#!/usr/bin/env bun
/**
 * Regenerates the docs API reference (releases.sh/docs/api/reference/*) from
 * the production OpenAPI spec. Run: `bun run docs:openapi`
 *
 * Writes three things under `apps/web/src/content/`:
 *
 *   1. `openapi.json` — a snapshot of the production `/v1/openapi.json`
 *      (public operations only; see `apps/api/src/api-surface.ts`), built
 *      in-process from the API worker's routes exactly like
 *      `check-openapi-coverage.ts` does. No network, D1, or Wrangler.
 *   2. `docs/api/reference/<page>.mdx` — one docs page per entry in `PAGES`,
 *      each rendering its operations with `<APIPage />` (fumadocs-openapi).
 *   3. The `---API Reference---` section of `docs/meta.json`.
 *
 * CI runs this and fails on a diff, so an API change that touches the public
 * spec ships with its regenerated reference. Every spec tag must belong to
 * exactly one page: a new tag fails here until someone places it.
 */
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mountV1Routes } from "../apps/api/src/v1-routes.js";
import type { Env } from "../apps/api/src/index.js";

type Page = {
  slug: string;
  title: string;
  /** Sidebar label (defaults to `title`). */
  label?: string;
  description: string;
  tags: string[];
};

/** Sidebar order. Each spec tag appears in exactly one page. */
const PAGES: Page[] = [
  {
    slug: "releases",
    title: "Releases",
    description: "Read individual releases and the latest releases across the index.",
    tags: ["Releases"],
  },
  {
    slug: "search",
    title: "Search",
    description: "Lexical, semantic, and hybrid search across orgs, products, and releases.",
    tags: ["Search"],
  },
  {
    slug: "orgs",
    title: "Organizations",
    label: "Orgs",
    description: "Organizations publish releases. List them, read one, and page through its feed.",
    tags: ["Orgs"],
  },
  {
    slug: "products",
    title: "Products",
    description: "The optional grouping layer between an org and its sources.",
    tags: ["Products"],
  },
  {
    slug: "sources",
    title: "Sources",
    description: "Changelog sources owned by an org, and the releases each one produced.",
    tags: ["Sources"],
  },
  {
    slug: "collections",
    title: "Collections",
    description: "Curated, named sets of orgs and their combined release feeds.",
    tags: ["Collections"],
  },
  {
    slug: "taxonomy",
    title: "Categories and tags",
    label: "Categories & tags",
    description: "Browse the index by category and tag.",
    tags: ["Taxonomy"],
  },
  {
    slug: "related",
    title: "Related",
    description: "Similarity rails for releases and sources.",
    tags: ["Related"],
  },
  {
    slug: "overviews",
    title: "Overviews",
    description: "AI-generated summaries of an org's or product's recent activity.",
    tags: ["Overviews"],
  },
  {
    slug: "lookups",
    title: "Lookups",
    description: "Resolve a domain, bare slug, or GitHub coordinate to its home in the index.",
    tags: ["Lookups"],
  },
  {
    slug: "account",
    title: "Account",
    description:
      "The signed-in caller: follows, the personalized feed, publish tokens, and alerts.",
    tags: ["Account"],
  },
  {
    slug: "api-keys",
    title: "API keys",
    description: "Create, list, and revoke read-only user API keys.",
    tags: ["Authentication"],
  },
  {
    slug: "webhooks",
    title: "Webhooks",
    description: "Manage outbound `release.created` webhook subscriptions.",
    tags: ["Webhooks"],
  },
  {
    slug: "listing",
    title: "Listing and claims",
    label: "Listing & claims",
    description: "Validate a releases.json manifest, activate a listing, and claim a domain.",
    tags: ["Listing"],
  },
  {
    slug: "site",
    title: "Stats and feedback",
    label: "Stats & feedback",
    description: "Registry stats, the site notice, feedback, and source recommendations.",
    tags: ["Stats", "Site", "Feedback", "Recommendations"],
  },
];

const ROOT = join(import.meta.dir, "..");
const CONTENT = join(ROOT, "apps", "web", "src", "content");
const SPEC_PATH = join(CONTENT, "openapi.json");
const REFERENCE_DIR = join(CONTENT, "docs", "api", "reference");
const META_PATH = join(CONTENT, "docs", "meta.json");
const SECTION = "API Reference";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Operation = { tags?: string[] };
type Spec = { paths: Record<string, Partial<Record<string, Operation>>> };

// ── 1. Build the production spec in-process ────────────────────────────────

const v1 = new Hono<Env>();
mountV1Routes(v1);
const app = new Hono();
app.route("/v1", v1);
// `mountOpenApi` reads `c.env.ENVIRONMENT`; production is the public spec.
const res = await app.request("/v1/openapi.json", {}, { ENVIRONMENT: "production" });
if (!res.ok) {
  console.error(`Failed to generate OpenAPI spec: HTTP ${res.status}`);
  process.exit(2);
}
const spec = (await res.json()) as Spec;
writeFileSync(SPEC_PATH, `${JSON.stringify(spec, null, 2)}\n`);

// ── 2. Group operations into pages ─────────────────────────────────────────

const pageForTag = new Map<string, Page>();
for (const page of PAGES) {
  for (const tag of page.tags) {
    if (pageForTag.has(tag)) throw new Error(`tag "${tag}" is listed on two PAGES`);
    pageForTag.set(tag, page);
  }
}

const opsByPage = new Map<string, Array<{ path: string; method: string }>>();
const unplaced = new Set<string>();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const tag = op.tags?.[0] ?? "(untagged)";
    const page = pageForTag.get(tag);
    if (!page) {
      unplaced.add(tag);
      continue;
    }
    const list = opsByPage.get(page.slug) ?? [];
    list.push({ path, method });
    opsByPage.set(page.slug, list);
  }
}
if (unplaced.size > 0) {
  console.error(
    `OpenAPI tags with no docs page: ${[...unplaced].join(", ")}.\n` +
      `Add them to PAGES in scripts/generate-openapi-docs.ts.`,
  );
  process.exit(1);
}
const pages = PAGES.filter((p) => opsByPage.has(p.slug));

// ── 3. Write one MDX page per entry ────────────────────────────────────────

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderPage(page: Page): string {
  const frontmatter = [
    "---",
    `title: ${yamlString(page.title)}`,
    `description: ${yamlString(page.description)}`,
    ...(page.label ? [`label: ${yamlString(page.label)}`] : []),
    "---",
  ];
  return [
    ...frontmatter,
    "",
    "{/* Generated by scripts/generate-openapi-docs.ts from the production OpenAPI spec. Do not edit; run `bun run docs:openapi`. */}",
    "",
    `# ${page.title}`,
    "",
    page.description,
    "",
    `<APIPage tags="${page.tags.join(",")}" />`,
    "",
  ].join("\n");
}

if (existsSync(REFERENCE_DIR)) {
  for (const file of readdirSync(REFERENCE_DIR)) {
    if (file.endsWith(".mdx")) rmSync(join(REFERENCE_DIR, file));
  }
}
mkdirSync(REFERENCE_DIR, { recursive: true });
for (const page of pages) {
  writeFileSync(join(REFERENCE_DIR, `${page.slug}.mdx`), renderPage(page));
}

// ── 4. Splice the sidebar section into meta.json ───────────────────────────

const meta = JSON.parse(readFileSync(META_PATH, "utf8")) as { pages: string[] };
const separator = `---${SECTION}---`;
const entries = [separator, ...pages.map((p) => `./api/reference/${p.slug}`)];
const start = meta.pages.indexOf(separator);
if (start === -1) {
  // First run: place the section right after the narrative API section.
  const after = meta.pages.findIndex(
    (item, i) => i > meta.pages.indexOf("---API---") && item.startsWith("---"),
  );
  meta.pages.splice(after === -1 ? meta.pages.length : after, 0, ...entries);
} else {
  let end = start + 1;
  while (end < meta.pages.length && !meta.pages[end].startsWith("---")) end++;
  meta.pages.splice(start, end - start, ...entries);
}
writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);

const count = [...opsByPage.values()].reduce((n, ops) => n + ops.length, 0);
console.log(`wrote ${pages.length} reference pages (${count} operations) + ${SPEC_PATH}`);
