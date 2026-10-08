import { Command } from "commander";
import chalk from "chalk";
import { getOrgCollections } from "../../api/collections.js";
import { findOrg, getSourcesByOrg, getTagsForOrg } from "../../api/orgs.js";
import { findProduct, getProductsByOrg, getTagsForProduct } from "../../api/products.js";
import { getRelease, getLatestReleases, getProductReleases } from "../../api/releases.js";
import { findSource } from "../../api/sources.js";
import type { CollectionListItem } from "@buildinternet/releases-api-types";
import type { Source } from "@buildinternet/releases-core/schema";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { renderReleaseRows } from "../render/releases-table.js";
import { slimReleaseDetail } from "../render/release-json.js";
import { humanDate } from "../../lib/release-display.js";
import { getEntityType, normalizeReleaseId, isLikelyBareId } from "@buildinternet/releases-core/id";
import { countTokensSafe } from "@buildinternet/releases-core/tokens";
import { writeJson } from "../../lib/output.js";
import { applyFieldMask } from "../../lib/fields.js";
import { formatNotice, type EntityWithNotice } from "../../lib/notice.js";

/** Format a payload-size annotation like `3.2K chars (~800 tokens)` so agents
 * can decide whether to pull the full content body before they spend the
 * round-trip. Token count uses `cl100k_base` via tiktoken (within ~5% of
 * Claude's tokenizer on English prose); see `packages/core/src/tokens.ts`. */
function formatSize(text: string): string {
  const chars = text.length;
  const tokens = countTokensSafe(text);
  const charsFmt =
    chars >= 1000 ? `${(chars / 1000).toFixed(chars >= 10_000 ? 0 : 1)}K` : String(chars);
  return `${charsFmt} chars (~${tokens.toLocaleString()} tokens)`;
}

export type GetEntityOpts = { json?: boolean; full?: boolean; fields?: string };

/**
 * Default count for the "Latest releases" preview embedded in get responses.
 * Kept small so the text output stays scannable / token-efficient — callers
 * who want more should pivot to `releases list` or the per-entity feed.
 */
const PREVIEW_RELEASE_COUNT = 5;

/** Footer hint pointing at the canonical drill-in for fuller detail. */
function printFooterHint(lines: string[]): void {
  if (lines.length === 0) return;
  console.log("");
  console.log(chalk.dim("Next steps:"));
  for (const line of lines) console.log(chalk.dim(`  ${line}`));
}

/**
 * Like `printFooterHint` but takes `[command, description]` pairs and aligns
 * the descriptions to a common column so the ` — ` markers line up regardless
 * of command length.
 */
function printAlignedHints(hints: [command: string, description: string][]): void {
  const width = Math.max(...hints.map(([cmd]) => cmd.length));
  printFooterHint(hints.map(([cmd, desc]) => `${cmd.padEnd(width)}  — ${desc}`));
}

/**
 * Trailing dim line carrying the entity's typed ID. Kept out of the metadata
 * block (where it was visual noise) but still present for copy/paste and
 * scripting off the human output.
 */
function printIdFooter(id: string): void {
  console.log("");
  console.log(chalk.dim(id));
}

/**
 * One-line entity header: `Name by OrgName (coord)`. The "by Org" clause is
 * dropped when the name already names the org — so App Store-style names like
 * "Claude by Anthropic" don't render "… by Anthropic by Anthropic" — and when
 * there's no parent org (orgs themselves). `coord` is the dim handle in parens:
 * `orgSlug/slug` for products and sources, the bare slug for orgs.
 */
function entityHeader(name: string, coord: string, org: { name: string } | null): string {
  const base = chalk.bold(name);
  const handle = chalk.dim(` (${coord})`);
  if (org && !name.toLowerCase().includes(org.name.toLowerCase())) {
    return `${base}${chalk.dim(" by ")}${org.name}${handle}`;
  }
  return `${base}${handle}`;
}

async function notFound(identifier: string, kind: string, opts: GetEntityOpts): Promise<never> {
  if (opts.json) await writeJson(null);
  logger.info(`No ${kind} matching: ${identifier}`);
  process.exit(1);
}

/** Shared action for both the canonical `get` command and the deprecated `show` alias. */
export async function getEntityAction(identifier: string, opts: GetEntityOpts): Promise<void> {
  const type = getEntityType(identifier);

  // --full/--fields only shape --json output. Warn once here, before routing,
  // so the notice fires for every entity kind (release/source/org/product),
  // not just whichever branch happened to carry the check.
  if (opts.full && !opts.json) logger.warn("--full only affects --json output; ignoring.");
  if (opts.fields && !opts.json) logger.warn("--fields only affects --json output; ignoring.");

  if (type === "release" || (type === "unknown" && isLikelyBareId(identifier))) {
    return getRelease_(normalizeReleaseId(identifier), opts);
  }
  if (type === "source") return getSource(identifier, opts);
  if (type === "org") return getOrg(identifier, opts);
  if (type === "product") return await getProduct(identifier, opts);

  const [org, product, source] = await Promise.all([
    findOrg(identifier),
    findProduct(identifier),
    findSource(identifier),
  ]);
  if (org) return renderOrg(org, opts);
  if (product) return await renderProduct(product, opts);
  if (source) return await renderSource(source, opts);

  return notFound(identifier, "entity", opts);
}

async function getRelease_(id: string, opts: GetEntityOpts) {
  const result = await getRelease(id);
  if (!result) return notFound(id, "release", opts);
  const rel = result;
  const contentChars = rel.content?.length ?? 0;
  const contentTokens = rel.content ? countTokensSafe(rel.content) : 0;

  if (opts.json) {
    // Slim by default (drops storage/pipeline internals + redundant title
    // variants); --full returns the complete unprojected payload. Computed
    // size annotations land on both shapes so agents can decide whether to
    // pull the body. #215. `--fields` then post-filters the chosen shape.
    await writeJson(
      applyFieldMask(
        slimReleaseDetail(rel, { contentChars, contentTokens, full: opts.full === true }),
        opts.fields,
      ),
    );
    return;
  }
  // Owning org is on the release-detail wire (and the slim JSON) but not the
  // narrow type — read it defensively so the card can name who ships the release.
  const org = (rel as { org?: { slug: string; name: string } | null }).org;
  console.log(chalk.bold(stripAnsi(rel.title)));
  console.log(`  ID:        ${rel.id}`);
  if (rel.version) console.log(`  Version:   ${stripAnsi(rel.version)}`);
  if (org) console.log(`  Org:       ${stripAnsi(org.name)} (${org.slug})`);
  console.log(
    `  Source:    ${rel.sourceName ? stripAnsi(rel.sourceName) : chalk.dim("—")} (${rel.sourceSlug ?? chalk.dim("—")})`,
  );
  if (rel.publishedAt) console.log(`  Published: ${humanDate(rel.publishedAt) || rel.publishedAt}`);
  if (rel.url) console.log(`  URL:       ${rel.url}`);
  if (rel.content) console.log(`  Content:   ${formatSize(rel.content)}`);
  if (rel.suppressed) {
    console.log(
      `  ${chalk.yellow("Suppressed")}${rel.suppressedReason ? `: ${stripAnsi(rel.suppressedReason)}` : ""}`,
    );
  }
  // Preview tier — never leave the response with only metadata between the
  // header and the footer. Order of preference:
  //   1. AI summary (richest)
  //   2. AI-generated headline (`titleGenerated` / `titleShort`) — cheap
  //      single-line context for releases the summarizer hasn't reached yet
  //   3. Slice of the raw content body — last-resort fallback so very old or
  //      unsummarized releases still show *something* useful before the user
  //      pivots to `release get`.
  if (rel.summary) {
    console.log("");
    console.log(chalk.dim("AI summary"));
    console.log(stripAnsi(rel.summary));
  } else if (rel.titleGenerated || rel.titleShort) {
    console.log("");
    console.log(chalk.dim("AI headline"));
    console.log(stripAnsi(rel.titleGenerated ?? rel.titleShort!));
  } else if (rel.content && rel.content.trim().length > 0) {
    const PREVIEW_CHARS = 280;
    const raw = stripAnsi(rel.content).trim();
    const truncated = raw.length > PREVIEW_CHARS;
    console.log("");
    console.log(
      chalk.dim(
        `Preview  · raw content${truncated ? ` (first ${PREVIEW_CHARS} of ${raw.length} chars)` : ""}`,
      ),
    );
    console.log(truncated ? raw.slice(0, PREVIEW_CHARS) + "…" : raw);
  }

  // Progressive disclosure: the dispatcher response never includes the full
  // release body (content can run 10K+ tokens). Always point callers at the
  // verbose command for the complete payload.
  printFooterHint([`releases release get ${rel.id}      — full release body (content + metadata)`]);
}

async function getSource(identifier: string, opts: GetEntityOpts) {
  const source = await findSource(identifier);
  if (!source) return notFound(identifier, "source", opts);
  await renderSource(source, opts);
}

async function getOrg(identifier: string, opts: GetEntityOpts) {
  const org = await findOrg(identifier);
  if (!org) return notFound(identifier, "organization", opts);
  await renderOrg(org, opts);
}

async function getProduct(identifier: string, opts: GetEntityOpts) {
  const product = await findProduct(identifier);
  if (!product) return notFound(identifier, "product", opts);
  await renderProduct(product, opts);
}

/** Loose Source shape — `findSource` returns the full row but callers historically
 * narrowed it. Accept the full schema row so we can surface fetch state. */
type SourceRow = Source &
  EntityWithNotice<{
    // Drizzle-derived fields that aren't in the published narrow Source export
    // but ARE on the wire (see `packages/core/src/schema.ts`).
    lastFetchedAt?: string | null;
    consecutiveErrors?: number | null;
    isHidden?: boolean | null;
    description?: string | null;
  }>;

async function renderSource(rawSource: unknown, opts: GetEntityOpts) {
  const source = rawSource as SourceRow;

  // Resolve org/product context + a small recent-releases preview in parallel.
  // Run for both text and JSON paths so the JSON contract is at least as
  // informative as the text card — agents shouldn't have to fall back to the
  // human output to discover what the dispatcher resolved. Failures degrade
  // silently so a broken sub-call doesn't blank the card.
  const [org, product, latest] = await Promise.all([
    source.orgId ? findOrg(source.orgId).catch(() => null) : Promise.resolve(null),
    source.productId ? findProduct(source.productId).catch(() => null) : Promise.resolve(null),
    getLatestReleases({ source: source.slug, count: PREVIEW_RELEASE_COUNT }).catch(() => []),
  ]);

  const status: "hidden" | "erroring" | "active" = source.isHidden
    ? "hidden"
    : source.consecutiveErrors && source.consecutiveErrors > 0
      ? "erroring"
      : "active";

  if (opts.json) {
    await writeJson(
      applyFieldMask(
        {
          ...source,
          status,
          org: org ? { id: org.id, slug: org.slug, name: org.name } : null,
          product: product ? { id: product.id, slug: product.slug, name: product.name } : null,
          latestReleases: latest,
        },
        opts.fields,
      ),
    );
    return;
  }

  const statusLabel =
    status === "hidden"
      ? chalk.red("hidden")
      : status === "erroring"
        ? chalk.yellow(`erroring (${source.consecutiveErrors} consecutive)`)
        : chalk.green("active");

  // Header folds the org + slug into "Name by OrgName (orgSlug/sourceSlug)".
  // Type label, ID, and the separate Slug/Org rows drop out; the ID moves to a
  // dim trailing line (see printIdFooter).
  const coord = org ? `${org.slug}/${source.slug}` : source.slug;
  console.log(entityHeader(source.name, coord, org));
  console.log(`  Type:       ${source.type}`);
  console.log(`  URL:        ${source.url}`);
  if (product) console.log(`  Product:    ${product.name} (${product.slug})`);
  console.log(`  Status:     ${statusLabel}`);
  if (source.lastFetchedAt) console.log(`  Last fetch: ${source.lastFetchedAt}`);
  if (source.notice) console.log(`  ${chalk.yellow(formatNotice(source.notice))}`);

  console.log("");
  if (latest.length === 0) {
    console.log(chalk.dim("No releases yet."));
  } else {
    console.log(
      chalk.dim(
        `Latest ${latest.length} release${latest.length === 1 ? "" : "s"} (most recent first):`,
      ),
    );
    console.log(renderReleaseRows(latest, { mode: "feed", showIdentity: false }));
  }

  printAlignedHints([
    [`releases latest ${source.slug}`, "full release feed (add --since 90d to window it)"],
    [`releases fetch-log ${source.slug}`, "recent fetch attempts and errors"],
    [`releases release get <rel_id>`, "open one release with full content"],
  ]);

  printIdFooter(source.id);
}

async function renderOrg(
  org: EntityWithNotice<{
    id: string;
    name: string;
    slug: string;
    domain: string | null;
    category: string | null;
    description?: string | null;
  }>,
  opts: GetEntityOpts,
) {
  // Collections degrade to empty on failure so an unrelated bug in the
  // collections endpoint doesn't break the canonical org card; the warning
  // surfaces real issues without aborting.
  const fetchCollections = async (): Promise<CollectionListItem[]> => {
    try {
      return (await getOrgCollections(org.slug)) ?? [];
    } catch (err) {
      logger.warn(`Failed to fetch collections for ${org.slug}: ${err}`);
      return [];
    }
  };
  const [releases, collections, sources, products, tags] = await Promise.all([
    getLatestReleases({ org: org.slug, count: PREVIEW_RELEASE_COUNT }),
    fetchCollections(),
    getSourcesByOrg(org.id).catch(() => []),
    getProductsByOrg(org.id).catch(() => []),
    getTagsForOrg(org.id).catch(() => []),
  ]);

  if (opts.json) {
    await writeJson(
      applyFieldMask({ ...org, releases, collections, sources, products, tags }, opts.fields),
    );
    return;
  }

  const activeSources = sources.filter((s) => !s.isHidden && !s.consecutiveErrors).length;
  const erroringSources = sources.filter(
    (s) => !s.isHidden && s.consecutiveErrors && s.consecutiveErrors > 0,
  ).length;
  const hiddenSources = sources.filter((s) => s.isHidden).length;

  // No parent, so the header is just "Name (slug)" — no "by" clause. The typed
  // ID drops to a dim trailing line (see printIdFooter).
  console.log(entityHeader(org.name, org.slug, null));
  if (org.domain) console.log(`  Domain:      ${org.domain}`);
  if (org.category) console.log(`  Category:    ${org.category}`);
  if (org.description) console.log(`  About:       ${stripAnsi(org.description)}`);
  if (tags.length > 0) console.log(`  Tags:        ${tags.join(", ")}`);
  if (sources.length > 0) {
    // Status breakdown only — the bare total is redundant with the parts (and
    // the active count is the part that actually carries signal).
    const breakdown: string[] = [];
    if (activeSources) breakdown.push(`${activeSources} active`);
    if (erroringSources) breakdown.push(chalk.yellow(`${erroringSources} erroring`));
    if (hiddenSources) breakdown.push(chalk.dim(`${hiddenSources} hidden`));
    if (breakdown.length > 0) console.log(`  Sources:     ${breakdown.join(", ")}`);
  }
  if (products.length > 0) {
    const names = products
      .slice(0, 5)
      .map((p) => `${p.name} ${chalk.dim(`(${p.slug})`)}`)
      .join(", ");
    const more = products.length > 5 ? chalk.dim(` +${products.length - 5} more`) : "";
    console.log(`  Products:    ${names}${more}`);
  }
  if (collections.length > 0) {
    const labels = collections.map((c) => `${c.name} ${chalk.dim(`(${c.slug})`)}`).join(", ");
    console.log(`  Collections: ${labels}`);
  }
  if (org.notice) console.log(`  ${chalk.yellow(formatNotice(org.notice))}`);

  console.log("");
  if (releases.length === 0) {
    console.log(chalk.dim("No releases yet."));
  } else {
    console.log(
      chalk.dim(
        `Latest ${releases.length} release${releases.length === 1 ? "" : "s"} (most recent first):`,
      ),
    );
    // Left column names the owning product (falling back to the source) so a
    // multi-product org's feed shows *which product* each release belongs to.
    console.log(renderReleaseRows(releases, { mode: "feed", identity: "product" }));
  }

  printAlignedHints([
    [`releases org get ${org.slug}`, "accounts, aliases, overview, full source list"],
    [`releases org overview ${org.slug}`, "AI-generated rollup"],
    [`releases latest --org ${org.slug}`, "full release feed (add --since 90d to window it)"],
  ]);

  printIdFooter(org.id);
}

async function renderProduct(
  product: EntityWithNotice<{
    id: string;
    name: string;
    slug: string;
    orgId: string;
    url: string | null;
    category: string | null;
    description?: string | null;
    avatarUrl?: string | null;
  }>,
  opts: GetEntityOpts,
) {
  // Pull related context concurrently. Each individually-degradable so a
  // single endpoint failure can't blank the product card. The release preview
  // uses the product's cross-source feed (GET /v1/orgs/:org/releases?product=…)
  // so products — now the primary unit — show recent activity inline instead of
  // forcing a round-trip into the org feed or a single source. The typed
  // `prod_…` id is globally unique, so it routes unambiguously regardless of
  // slug collisions across orgs.
  const [org, orgProducts, orgSources, tags, productFeed] = await Promise.all([
    findOrg(product.orgId).catch(() => null),
    getProductsByOrg(product.orgId).catch(() => []),
    getSourcesByOrg(product.orgId).catch<Source[]>(() => []),
    getTagsForProduct(product.id).catch(() => []),
    getProductReleases({
      orgRef: product.orgId,
      product: product.id,
      count: PREVIEW_RELEASE_COUNT,
    }).catch(() => null),
  ]);
  const releases = productFeed?.releases ?? [];

  // /v1/sources?orgId=… returns the SourceWithOrg projection, which carries
  // productSlug/productName but not productId — match on slug to keep this
  // working without an extra round-trip per source.
  const productSources = orgSources.filter(
    (s) => (s as unknown as { productSlug?: string | null }).productSlug === product.slug,
  );
  const sourceCountRow = orgProducts.find((p) => p.id === product.id);
  const sourceCount = sourceCountRow?.sourceCount ?? productSources.length;

  if (opts.json) {
    await writeJson(
      applyFieldMask(
        {
          ...product,
          orgSlug: org?.slug ?? null,
          sources: productSources,
          sourceCount,
          tags,
          releases,
        },
        opts.fields,
      ),
    );
    return;
  }

  // Header folds the org + slug into one line: "Name by OrgName (orgSlug/slug)".
  // The entity type is implied by the coordinate shape and `get`'s resolution,
  // so there's no standalone "Product" label or separate Org/Slug rows. The
  // coordinate (`orgSlug/productSlug`) doubles as the unambiguous handle for
  // the footer commands — bare slugs are per-org-unique since #698.
  const coord = org ? `${org.slug}/${product.slug}` : product.slug;
  console.log(entityHeader(product.name, coord, org));
  if (product.url) console.log(`  URL:      ${product.url}`);
  if (product.category) console.log(`  Category: ${product.category}`);
  if (product.avatarUrl) console.log(`  Icon:     ${product.avatarUrl}`);
  if (product.description) console.log(`  About:    ${stripAnsi(product.description)}`);
  if (tags.length > 0) console.log(`  Tags:     ${tags.join(", ")}`);
  if (productSources.length > 0) {
    // List the source slugs (the count is redundant — you can see them).
    const preview = productSources
      .slice(0, 5)
      .map((s) => chalk.dim(`(${s.slug})`))
      .join(" ");
    const more = productSources.length > 5 ? chalk.dim(` +${productSources.length - 5}`) : "";
    console.log(`  Sources:  ${preview}${more}`);
  }
  if (product.notice) console.log(`  ${chalk.yellow(formatNotice(product.notice))}`);

  console.log("");
  if (releases.length === 0) {
    console.log(chalk.dim("No releases yet."));
  } else {
    console.log(
      chalk.dim(
        `Latest ${releases.length} release${releases.length === 1 ? "" : "s"} (most recent first):`,
      ),
    );
    console.log(renderReleaseRows(releases, { mode: "feed", showIdentity: false }));
  }

  // Lead with the product's own cross-source feed — products are the primary
  // unit, so the full feed plus a time-windowed variant are the obvious next
  // steps (both compose with --json, --kind, etc.). Dropped the old
  // "drill into one source" hint: it pointed at an arbitrary first source via
  // an opaque src_ id; the Sources line above already lists the slugs.
  printAlignedHints([
    [`releases latest --product ${coord}`, "full release feed for this product"],
    [`releases latest --product ${coord} --since 90d`, "just the last 90 days"],
  ]);

  printIdFooter(product.id);
}

export function registerGetCommand(program: Command) {
  program
    .command("get")
    .description("Get details for any entity by ID or slug")
    .argument("<identifier>", "ID (rel_/src_/org_/prod_) or slug")
    .option("--json", "Output as JSON")
    .option("--full", "With --json on a release, return the complete unprojected payload")
    .option(
      "--fields <list>",
      "With --json, project the output down to a comma-separated field mask " +
        "(dot-notation for nested keys, e.g. id,version,source.slug). Composes with --full.",
    )
    .action(getEntityAction);
}
