#!/usr/bin/env bun
/**
 * Regenerates the docs API reference (releases.sh/docs/api/reference/*) from
 * the production OpenAPI spec. Run: `bun run docs:openapi`
 *
 * Writes three things under `apps/web/src/content/`:
 *
 *   1. `openapi.json` — a minified snapshot of the production
 *      `/v1/openapi.json` (public operations only; see
 *      `apps/api/src/api-surface.ts`), built in-process from the API worker's
 *      routes exactly like `check-openapi-coverage.ts` does. No network, D1,
 *      or Wrangler. Marked generated in `.gitattributes`.
 *   2. `docs/api/reference/<group>/<endpoint>.mdx` — one docs page per
 *      endpoint, each rendering `<APIPage operations="…" />` (fumadocs-openapi).
 *      Dual-registered routes that share a summary (the bare `/products/:id`
 *      and org-scoped `/orgs/:org/products/:slug` forms) share one page.
 *   3. The `---API Reference---` section of `docs/meta.json`.
 *
 * CI runs this and fails on a diff, so an API change that touches the public
 * spec ships with its regenerated reference. Every spec tag must belong to
 * exactly one group: a new tag fails here until someone places it.
 */
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mountV1Routes } from "../apps/api/src/v1-routes.js";
import type { Env } from "../apps/api/src/index.js";

type Group = {
  slug: string;
  /** Sidebar group heading. */
  title: string;
  tags: string[];
};

/** Sidebar order. Each spec tag appears in exactly one group. */
const GROUPS: Group[] = [
  { slug: "releases", title: "Releases", tags: ["Releases"] },
  { slug: "search", title: "Search", tags: ["Search"] },
  { slug: "orgs", title: "Orgs", tags: ["Orgs"] },
  { slug: "products", title: "Products", tags: ["Products"] },
  { slug: "sources", title: "Sources", tags: ["Sources"] },
  { slug: "collections", title: "Collections", tags: ["Collections"] },
  { slug: "taxonomy", title: "Categories & tags", tags: ["Taxonomy"] },
  { slug: "related", title: "Related", tags: ["Related"] },
  { slug: "overviews", title: "Overviews", tags: ["Overviews"] },
  { slug: "lookups", title: "Lookups", tags: ["Lookups"] },
  { slug: "account", title: "Account", tags: ["Account"] },
  { slug: "api-keys", title: "API keys", tags: ["Authentication"] },
  { slug: "webhooks", title: "Webhooks", tags: ["Webhooks"] },
  { slug: "listing", title: "Listing & claims", tags: ["Listing"] },
  {
    slug: "site",
    title: "Stats & feedback",
    tags: ["Stats", "Site", "Feedback", "Recommendations"],
  },
];

/**
 * Short sidebar labels for summaries too long for the 180px rail, keyed by
 * the page's first operationId. The page title stays the full summary.
 */
const LABELS: Record<string, string> = {
  getStats: "Registry stats",
  getReleasesLatest: "Latest releases",
  getWhatsChanged: "What's changed",
  getSearch: "Search",
  getRelatedReleases: "Related releases",
  getRelatedSources: "Related sources",
  getOrgsBySlugManifest: "Export manifest",
  getOrgsBySlugCollections: "Org collections",
  getOrgsBySlugAccounts: "List org accounts",
  getOrgsBySlugReleases: "Org release feed",
  getOrgsByOrgResolveBySlug: "Resolve a slug",
  getOrgsBySlugProducts: "List org products",
  getProductsBySlugCollections: "Product collections",
  postLookups: "Materialize a GitHub source",
  getLookupsSourceBySlug: "Source by slug",
  getLookupsSourceByCoordinate: "Source by coordinate",
  getLookupsProductBySlug: "Product by slug",
  getLookupsByDomain: "Org by domain",
  getCategories: "List categories",
  getCategoriesBySlug: "Get category",
  getCategoriesBySlugReleases: "Category release feed",
  getTagsBySlug: "Get tag",
  getCollectionsBySlug: "Get collection",
  getCollectionsBySlugReleases: "Collection release feed",
  getCollectionsBySlugDailySummaries: "Daily summaries",
  getCollectionsBySlugDigests: "Weekly digests",
  getCollectionsBySlugDigestsLatest: "Latest digest",
  getCollectionsBySlugDigestsByWeekStart: "Digest by week",
  deleteTokensMe: "Revoke the current key",
  postMePublishTokens: "Mint a publish token",
  getMeFeed: "Personalized feed",
  getMeSemanticAlertsById: "Get a semantic alert",
  getMeWebhooks: "List personal webhooks",
  postMeWebhooks: "Create a personal webhook",
  getMeWebhooksById: "Get a personal webhook",
  patchMeWebhooksById: "Update a personal webhook",
  deleteMeWebhooksById: "Delete a personal webhook",
  postMeWebhooksByIdRotateSecret: "Rotate a personal secret",
  postMeWebhooksByIdTest: "Test a personal webhook",
  getMeWebhooksByIdDeliveries: "Personal deliveries",
  getWorkspacesByWorkspaceIdWebhooks: "List workspace webhooks",
  postWorkspacesByWorkspaceIdWebhooks: "Create a workspace webhook",
  getWorkspacesByWorkspaceIdWebhooksById: "Get a workspace webhook",
  patchWorkspacesByWorkspaceIdWebhooksById: "Update a workspace webhook",
  deleteWorkspacesByWorkspaceIdWebhooksById: "Delete a workspace webhook",
  postWorkspacesByWorkspaceIdWebhooksByIdRotateSecret: "Rotate a workspace secret",
  postWorkspacesByWorkspaceIdWebhooksByIdTest: "Test a workspace webhook",
  getWorkspacesByWorkspaceIdWebhooksByIdDeliveries: "Workspace deliveries",
  getListingCapabilities: "Capabilities",
  postListingValidate: "Validate a manifest",
  postListingActivate: "Activate a listing",
  postListingClaim: "Start a claim",
  postListingClaimVerify: "Verify a claim",
  getListingClaims: "List your claims",
  deleteListingClaimsById: "Release a claim",
  postListingPromote: "Promote a listing",
  postRecommendations: "Recommend a source",
};

/** Labels longer than this need a `LABELS` entry, or they wrap in the sidebar. */
const MAX_LABEL = 28;

const ROOT = join(import.meta.dir, "..");
const CONTENT = join(ROOT, "apps", "web", "src", "content");
const SPEC_PATH = join(CONTENT, "openapi.json");
const REFERENCE_DIR = join(CONTENT, "docs", "api", "reference");
const META_PATH = join(CONTENT, "docs", "meta.json");
const SECTION = "API Reference";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Operation = { operationId?: string; tags?: string[]; summary?: string; description?: string };
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
// Minified: an API change diffs as one line instead of thousands.
writeFileSync(SPEC_PATH, `${JSON.stringify(spec)}\n`);

// ── 2. Group operations into endpoint pages ────────────────────────────────

const groupForTag = new Map<string, Group>();
for (const group of GROUPS) {
  for (const tag of group.tags) {
    if (groupForTag.has(tag)) throw new Error(`tag "${tag}" is listed on two GROUPS`);
    groupForTag.set(tag, group);
  }
}

type Page = {
  group: Group;
  slug: string;
  method: string;
  title: string;
  label: string;
  description: string;
  operationIds: string[];
};

function slugify(text: string): string {
  return text
    .replace(/\(.*?\)/g, "")
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
}

/** First sentence of an operation description, for the page's meta description. */
function firstSentence(text: string | undefined): string | undefined {
  const flat = text?.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const match = flat.match(/^(.+?[.!?])(\s|$)/);
  return (match ? match[1] : flat).slice(0, 200);
}

const pagesByKey = new Map<string, Page>();
const unplaced = new Set<string>();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const tag = op.tags?.[0] ?? "(untagged)";
    const group = groupForTag.get(tag);
    if (!group) {
      unplaced.add(tag);
      continue;
    }
    if (!op.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
    const title = op.summary ?? `${method.toUpperCase()} ${path}`;
    const key = `${group.slug}\0${method}\0${title}`;
    const existing = pagesByKey.get(key);
    if (existing) {
      existing.operationIds.push(op.operationId);
      continue;
    }
    const label = LABELS[op.operationId] ?? title;
    pagesByKey.set(key, {
      group,
      // Curated labels make tidier URLs than truncated summaries.
      slug: slugify(label),
      method,
      title,
      label,
      description: firstSentence(op.description) ?? title,
      operationIds: [op.operationId],
    });
  }
}
if (unplaced.size > 0) {
  console.error(
    `OpenAPI tags with no docs group: ${[...unplaced].join(", ")}.\n` +
      `Add them to GROUPS in scripts/generate-openapi-docs.ts.`,
  );
  process.exit(1);
}

const pages = GROUPS.flatMap((g) => [...pagesByKey.values()].filter((p) => p.group === g));
const seen = new Set<string>();
const problems: string[] = [];
for (const page of pages) {
  const path = `${page.group.slug}/${page.slug}`;
  if (seen.has(path)) problems.push(`two endpoints map to ${path}`);
  seen.add(path);
  if (page.label.length > MAX_LABEL) {
    problems.push(
      `"${page.label}" is too long for the sidebar; add LABELS.${page.operationIds[0]}`,
    );
  }
}
const unusedLabels = Object.keys(LABELS).filter(
  (id) => !pages.some((p) => p.operationIds[0] === id),
);
for (const id of unusedLabels) problems.push(`LABELS.${id} matches no page; remove it`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

// ── 3. Write one MDX page per endpoint ─────────────────────────────────────

const yamlString = (value: string) => JSON.stringify(value);

function renderPage(page: Page): string {
  return [
    "---",
    `title: ${yamlString(page.title)}`,
    `description: ${yamlString(page.description)}`,
    ...(page.label !== page.title ? [`label: ${yamlString(page.label)}`] : []),
    `navGroup: ${yamlString(page.group.title)}`,
    `apiMethod: ${page.method.toUpperCase()}`,
    "---",
    "",
    "{/* Generated by scripts/generate-openapi-docs.ts from the production OpenAPI spec. Do not edit; run `bun run docs:openapi`. */}",
    "",
    `# ${page.title}`,
    "",
    `<APIPage operations="${page.operationIds.join(",")}" />`,
    "",
  ].join("\n");
}

if (existsSync(REFERENCE_DIR)) rmSync(REFERENCE_DIR, { recursive: true });
for (const page of pages) {
  const dir = join(REFERENCE_DIR, page.group.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${page.slug}.mdx`), renderPage(page));
}

// The area's landing page: what the API is, then every endpoint by group.
const index = [
  "---",
  'title: "API Reference"',
  'description: "Every public endpoint of the Releases REST API, with parameters, schemas, code samples, and a try-it playground."',
  "---",
  "",
  "{/* Generated by scripts/generate-openapi-docs.ts from the production OpenAPI spec. Do not edit; run `bun run docs:openapi`. */}",
  "",
  "# API Reference",
  "",
  "Every public endpoint of the Releases REST API, generated from the [OpenAPI 3.1 spec](https://api.releases.sh/v1/openapi.json). Each page lists the endpoint's parameters, request and response schemas, and code samples, and has a playground for sending a real request.",
  "",
  "- **Base URL:** `https://api.releases.sh/v1`",
  "- **Auth:** most reads are public. Account and write endpoints take a Bearer token. See [Authentication](/docs/api/rest#authentication).",
  "- **Conventions:** pagination, date filters, and resource shapes are covered in [REST API](/docs/api/rest). Error responses are in [Errors](/docs/api/errors).",
  "",
  ...GROUPS.flatMap((group) => {
    const groupPages = pages.filter((p) => p.group === group);
    if (groupPages.length === 0) return [];
    return [
      `## ${group.title}`,
      "",
      ...groupPages.map(
        (p) =>
          `- \`${p.method.toUpperCase()}\` [${p.title}](/docs/api/reference/${group.slug}/${p.slug})`,
      ),
      "",
    ];
  }),
].join("\n");
writeFileSync(join(CONTENT, "docs", "api", "reference.mdx"), index);

// ── 4. Splice the sidebar section into meta.json ───────────────────────────

const meta = JSON.parse(readFileSync(META_PATH, "utf8")) as { pages: string[] };
const separator = `---${SECTION}---`;
const entries = [separator, ...pages.map((p) => `./api/reference/${p.group.slug}/${p.slug}`)];
const start = meta.pages.indexOf(separator);
if (start === -1) {
  // First run: place the section right after the narrative API section.
  const api = meta.pages.indexOf("---API---");
  const after = meta.pages.findIndex((item, i) => i > api && item.startsWith("---"));
  meta.pages.splice(after === -1 ? meta.pages.length : after, 0, ...entries);
} else {
  let end = start + 1;
  while (end < meta.pages.length && !meta.pages[end].startsWith("---")) end++;
  meta.pages.splice(start, end - start, ...entries);
}
writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);

// Run the outputs through oxfmt so they match what the pre-commit hook and
// `format:check` produce (YAML quoting, etc.) and CI's drift check is stable.
const format = spawnSync(
  "bunx",
  ["oxfmt", "--write", REFERENCE_DIR, join(CONTENT, "docs", "api", "reference.mdx"), META_PATH],
  { stdio: "inherit" },
);
if (format.status !== 0) process.exit(format.status ?? 1);

const count = pages.reduce((n, p) => n + p.operationIds.length, 0);
console.log(`wrote ${pages.length} endpoint pages (${count} operations) + ${SPEC_PATH}`);
