import { Command } from "commander";
import chalk from "chalk";
import { unifiedSearch } from "../../api/sources.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { isValidKind, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import type { LookupResultPayload, UnifiedSearchResponse } from "../../api/types.js";
import { writeJson } from "../../lib/output.js";
import { parseFieldsFlag, projectFields, unmatchedFields } from "../../lib/fields.js";
import { parseTimeWindowFlag } from "../../lib/flags.js";
import { renderReleaseRows } from "../render/releases-table.js";
import { slimSearchHit } from "../render/release-json.js";
import { humanDate, type ReleaseRow } from "../../lib/release-display.js";

const SEARCH_MODES = ["lexical", "semantic", "hybrid"] as const;
type SearchMode = (typeof SEARCH_MODES)[number];

function parseMode(raw: string | undefined): SearchMode | undefined {
  if (raw === undefined) return undefined;
  if ((SEARCH_MODES as readonly string[]).includes(raw)) return raw as SearchMode;
  throw new Error(`Invalid --mode value: "${raw}". Expected one of: ${SEARCH_MODES.join(", ")}.`);
}

type SearchSection = "orgs" | "catalog" | "releases" | "collections";

function normalizeType(raw: string): SearchSection {
  if (raw === "products") return "catalog";
  if (raw === "orgs" || raw === "catalog" || raw === "releases" || raw === "collections") {
    return raw;
  }
  throw new Error(
    `Invalid --type value: "${raw}". Expected one of: orgs, catalog, releases, collections.`,
  );
}

const PREVIEW_LIMIT = 5;

function formatShortDate(iso: string | null): string {
  return humanDate(iso) || "No date";
}

function renderLookup(lookup: LookupResultPayload, query: string): void {
  console.log(chalk.bold.underline("Lookup"));

  const { status, source, releases, relatedOrg } = lookup;

  // Status label — green for found, dim for not-found variants
  const isFound = status === "indexed" || status === "existing";
  const statusLabel = isFound
    ? chalk.green.bold(status.toUpperCase())
    : chalk.dim(status.toUpperCase());

  const coordinate = source?.name ?? query;
  console.log(`  ${statusLabel}  ${chalk.cyan.bold(stripAnsi(coordinate))}`);

  // Status body
  switch (status) {
    case "indexed":
      console.log(`  Just indexed ${stripAnsi(coordinate)}. We pulled this from GitHub on demand.`);
      break;
    case "existing":
      console.log(`  Indexed ${stripAnsi(coordinate)}. (cached)`);
      break;
    case "empty":
      console.log(`  ${stripAnsi(query)}: real repo, but no tagged releases or CHANGELOG yet.`);
      break;
    case "not_found":
      console.log(
        `  ${stripAnsi(query)}: no public repo found at github.com/${stripAnsi(query)}. May be private, archived, or renamed.`,
      );
      break;
    case "deferred":
      console.log(`  ${stripAnsi(query)}: indexing in progress. Try again in a moment.`);
      break;
  }

  // Source link when available
  if (source?.slug) {
    console.log(chalk.dim(`  View source: https://releases.sh/source/${source.slug}`));
  }

  // Release preview
  if (releases && releases.length > 0) {
    console.log();
    console.log(chalk.dim("  Recent releases:"));
    const shown = releases.slice(0, PREVIEW_LIMIT);
    for (const r of shown) {
      const ver = r.version ? chalk.cyan(r.version) : chalk.dim("(no version)");
      const date = chalk.dim(formatShortDate(r.publishedAt));
      console.log(`    ${ver}   ${date}`);
    }
    const remaining = releases.length - shown.length;
    if (remaining > 0) {
      console.log(chalk.dim(`    (${remaining} more)`));
    }
  }

  // Related org rail
  if (relatedOrg) {
    console.log();
    console.log(
      `  ${chalk.dim("Did you mean:")} ${chalk.cyan.bold(stripAnsi(relatedOrg.org.name))}`,
    );
    for (const s of relatedOrg.sources) {
      const nameCol = stripAnsi(s.name).padEnd(20);
      console.log(`    ${chalk.bold(nameCol)}  ${chalk.dim(s.url)}`);
    }
  }

  console.log();
}

export function registerSearchCommand(program: Command) {
  program
    .command("search")
    .description("Search across organizations, collections, the catalog, and releases")
    .argument("<query>", "Search query")
    .option("-l, --limit <n>", "Max results per type", "10")
    .option("--type <type>", "Limit to a result type: orgs, catalog, releases, collections")
    .option("--mode <mode>", `Search mode: ${SEARCH_MODES.join(" | ")}`)
    .option(
      "--domain <domain>",
      "Scope to the org owning this domain (URL-shaped input is normalized)",
    )
    .option(
      "--product <identifier>",
      "Scope hits to one product's sources (org/slug coordinate, prod_… id, or product slug)",
    )
    .option(
      "--category <slug>",
      `Scope hits to organizations in a category (${CATEGORIES.join(", ")}). See 'releases categories'.`,
    )
    .option(
      "--collection <slug>",
      "Scope hits to a curated collection's member orgs (e.g. coding-agents)",
    )
    .option(
      "--kind <kind>",
      `Filter by taxonomy (${KIND_VALUES.join(", ")}). Release hits use COALESCE(source.kind, product.kind); catalog hits match the row's own kind only.`,
    )
    .option(
      "--since <when>",
      "Only release hits published on/after this date. ISO (2026-01-01) or shorthand (90d, 4w, 6m, 2y).",
    )
    .option(
      "--until <when>",
      "Only release hits published on/before this date. Same formats as --since.",
    )
    .option("--json", "Output as JSON")
    .option("--full", "With --json, return complete unprojected release hits")
    .option(
      "--fields <list>",
      "With --json, project each hit (releases/catalog/collections) to a comma-separated " +
        "field mask (dot-notation for nested keys, e.g. id,source.slug). Composes with --full.",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases search "breaking change"               Full-text + semantic search
  releases search "breaking change" --kind sdk    Narrow to SDK sources
  releases search "slack integration" --since 90d Only hits from the last 90 days
  releases search webhooks --product vercel/next-js   Scope a term to one product
  releases search mcp --category developer-tools  Scope to dev-tools companies
  releases search agents --collection coding-agents   Scope to a collection
  releases search vercel --type orgs              Show only org matches
  releases search shopify/hydrogen                Coordinate lookup (GitHub)`,
    )
    .action(
      async (
        query: string,
        opts: {
          limit: string;
          type?: string;
          mode?: string;
          domain?: string;
          product?: string;
          category?: string;
          collection?: string;
          kind?: string;
          since?: string;
          until?: string;
          json?: boolean;
          full?: boolean;
          fields?: string;
        },
      ) => {
        const limit = parseInt(opts.limit, 10);
        if (opts.full && !opts.json) logger.warn("--full only affects --json output; ignoring.");
        if (opts.fields && !opts.json)
          logger.warn("--fields only affects --json output; ignoring.");

        let mode: SearchMode | undefined;
        try {
          mode = parseMode(opts.mode);
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        if (opts.kind !== undefined && !isValidKind(opts.kind)) {
          logger.error(
            `Invalid --kind value: "${opts.kind}". Must be one of: ${KIND_VALUES.join(", ")}`,
          );
          process.exit(1);
        }
        const kind = opts.kind as Kind | undefined;

        // No client-side --category gate: the API is the source of truth and
        // resolves curator aliases (e.g. "e-commerce" → "commerce"), which the
        // canonical `CATEGORIES` list here can't see. A local `isValidCategory`
        // check would wrongly reject valid aliases, so we forward the value and
        // let the API 400 on a genuinely unknown category.

        let types: readonly SearchSection[];
        try {
          types = opts.type
            ? [normalizeType(opts.type)]
            : (["orgs", "catalog", "releases", "collections"] as const);
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        // Validate the window locally for a fast, clear error; the API resolves
        // relative shorthand (90d/4w/6m/2y) server-side, so we forward verbatim.
        const since = parseTimeWindowFlag("since", opts.since);
        const until = parseTimeWindowFlag("until", opts.until);

        const searchOpts: {
          mode?: SearchMode;
          domain?: string;
          product?: string;
          category?: string;
          collection?: string;
          kind?: Kind;
          since?: string;
          until?: string;
        } = {};
        if (mode) searchOpts.mode = mode;
        if (opts.domain) searchOpts.domain = opts.domain;
        if (opts.product) searchOpts.product = opts.product;
        if (opts.category) searchOpts.category = opts.category;
        if (opts.collection) searchOpts.collection = opts.collection;
        if (kind) searchOpts.kind = kind;
        if (since) searchOpts.since = since;
        if (until) searchOpts.until = until;
        const response = await unifiedSearch(
          query,
          limit,
          Object.keys(searchOpts).length > 0 ? searchOpts : undefined,
        );

        if (!opts.json && response.domainStatus !== undefined) {
          const scopedDomain = response.domain ?? opts.domain;
          if (response.domainStatus === "not_found") {
            logger.warn(`No org owns the domain "${scopedDomain}". Showing no results.`);
          } else if (response.domainStatus === "matched") {
            const scopedOrgName = response.orgs[0]?.name ?? scopedDomain;
            logger.info(`Scoped to ${scopedOrgName} (${scopedDomain}).`);
          }
        }

        // `?product=` echo mirrors `?domain=`, but #1218 added no api-types
        // shape for it — read the fields loosely (same pattern as the legacy
        // `products`/`collections` reads below) until the wire type lands.
        const productEcho = response as unknown as {
          product?: string;
          productStatus?: "matched" | "not_found";
        };
        if (!opts.json && productEcho.productStatus !== undefined) {
          const scopedProduct = productEcho.product ?? opts.product;
          if (productEcho.productStatus === "not_found") {
            logger.warn(`No product matching "${scopedProduct}". Showing no results.`);
          } else if (productEcho.productStatus === "matched") {
            logger.info(`Scoped to product ${scopedProduct}.`);
          }
        }

        // `?category=` / `?collection=` echoes (#371). Read loosely, same
        // pattern as the `?product=` echo above — the api-types pin here may
        // predate the shape landing on UnifiedSearchResponse.
        const scopeEcho = response as unknown as {
          category?: string;
          categoryStatus?: "matched";
          collection?: string;
          collectionStatus?: "matched" | "not_found";
        };
        if (!opts.json && scopeEcho.categoryStatus === "matched") {
          logger.info(`Scoped to category ${scopeEcho.category ?? opts.category}.`);
        }
        if (!opts.json && scopeEcho.collectionStatus !== undefined) {
          const scopedCollection = scopeEcho.collection ?? opts.collection;
          if (scopeEcho.collectionStatus === "not_found") {
            logger.warn(`No collection matching "${scopedCollection}". Showing no results.`);
          } else if (scopeEcho.collectionStatus === "matched") {
            logger.info(`Scoped to collection ${scopedCollection}.`);
          }
        }

        // Read the new `catalog` field, falling back to the deprecated `products`
        // alias so older API deployments keep working. Drop the fallback once
        // the alias is removed from the wire. Bracket access avoids the
        // deprecation diagnostic on the alias read.
        const legacy = (response as unknown as Record<string, unknown>)["products"] as
          | UnifiedSearchResponse["catalog"]
          | undefined;
        const catalog: UnifiedSearchResponse["catalog"] = response.catalog ?? legacy ?? [];
        // `collections` is optional on the wire — older API deployments emit it
        // as `undefined`. Treat missing and `[]` identically so the CLI doesn't
        // blow up before the feature lands in production. Inline the shape so
        // the CLI can read it before the api-types pin bumps to a version that
        // exports the field on UnifiedSearchResponse.
        type SearchCollectionHit = {
          slug: string;
          name: string;
          description: string | null;
          memberCount: number;
          via: "direct" | "member";
          score?: number;
          matchedOrgSlugs?: string[];
        };
        const collections: SearchCollectionHit[] =
          (response as unknown as { collections?: SearchCollectionHit[] }).collections ?? [];

        if (opts.json) {
          const filtered: Record<string, unknown> = { query: response.query };
          for (const t of types) {
            if (t === "catalog") filtered[t] = catalog;
            else if (t === "collections") filtered[t] = collections;
            else if (t === "releases")
              filtered[t] = response.releases.map((h) => slimSearchHit(h, opts.full === true));
            else filtered[t] = response[t];
          }
          if (response.mode !== undefined) filtered.mode = response.mode;
          if (response.degraded !== undefined) filtered.degraded = response.degraded;
          if (response.degradedReason !== undefined)
            filtered.degradedReason = response.degradedReason;
          if (response.domain !== undefined) filtered.domain = response.domain;
          if (response.domainStatus !== undefined) filtered.domainStatus = response.domainStatus;
          if (productEcho.product !== undefined) filtered.product = productEcho.product;
          if (productEcho.productStatus !== undefined)
            filtered.productStatus = productEcho.productStatus;
          if (response.lookup != null) filtered.lookup = response.lookup;
          if (opts.fields !== undefined) {
            // Project the entity hit arrays (releases/catalog/collections) by the
            // mask; the wrapper metadata (query/mode/degraded/…) is preserved. A
            // field that resolves in none of the arrays gets one stderr warning.
            const maskFields = parseFieldsFlag(opts.fields);
            if (maskFields.length > 0) {
              const matched = new Set<string>();
              for (const key of ["releases", "catalog", "collections"] as const) {
                if (Array.isArray(filtered[key])) {
                  const res = projectFields(filtered[key], maskFields);
                  filtered[key] = res.projected;
                  res.matched.forEach((m) => matched.add(m));
                }
              }
              const missing = unmatchedFields(maskFields, matched);
              if (missing.length > 0)
                logger.warn(
                  `--fields: ignored unknown field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
                );
            }
          }
          await writeJson(filtered);
          return;
        }

        if (response.degraded) {
          logger.warn(
            `Search degraded to lexical${response.degradedReason ? `: ${response.degradedReason}` : ""}.`,
          );
        }

        let totalResults = 0;

        // Lookup rail — always shown when present, regardless of --type filter.
        if (response.lookup != null) {
          renderLookup(response.lookup, query);
          totalResults += 1;
        }

        if (types.includes("orgs") && response.orgs.length > 0) {
          console.log(chalk.bold.underline("Organizations"));
          for (const org of response.orgs) {
            const meta = [org.category, org.domain].filter(Boolean).join(" | ");
            console.log(`  ${chalk.cyan.bold(stripAnsi(org.name))} ${chalk.dim(`(${org.slug})`)}`);
            if (meta) console.log(`  ${chalk.dim(meta)}`);
          }
          console.log();
          totalResults += response.orgs.length;
        }

        if (types.includes("catalog") && catalog.length > 0) {
          console.log(chalk.bold.underline("Catalog"));
          for (const p of catalog) {
            const org = p.orgName ? ` ${chalk.dim(`by ${stripAnsi(p.orgName)}`)}` : "";
            console.log(
              `  ${chalk.cyan.bold(stripAnsi(p.name))} ${chalk.dim(`(${p.slug})`)}${org}`,
            );
          }
          console.log();
          totalResults += catalog.length;
        }

        if (types.includes("collections") && collections.length > 0) {
          console.log(chalk.bold.underline("Collections"));
          for (const c of collections) {
            const count = c.memberCount === 1 ? "1 member" : `${c.memberCount} members`;
            console.log(
              `  ${chalk.cyan.bold(stripAnsi(c.name))} ${chalk.dim(`(${c.slug})`)} ${chalk.dim(`— ${count}`)}`,
            );
            if (c.via === "member" && c.matchedOrgSlugs && c.matchedOrgSlugs.length > 0) {
              console.log(chalk.dim(`  ↳ includes ${c.matchedOrgSlugs.join(", ")}`));
            }
            if (c.description) {
              const desc = stripAnsi(c.description);
              console.log(chalk.dim(`  ${desc}`));
            }
          }
          console.log();
          totalResults += collections.length;
        }

        if (types.includes("releases") && response.releases.length > 0) {
          console.log(chalk.bold.underline("Releases"));
          const rows: ReleaseRow[] = response.releases.map((r) => ({
            id: r.id,
            title: r.title,
            version: r.version,
            summary: r.summary ?? null,
            titleGenerated: r.titleGenerated ?? null,
            titleShort: r.titleShort ?? null,
            content: r.content ?? null,
            publishedAt: r.publishedAt,
            sourceName: r.sourceName,
            sourceSlug: r.sourceSlug,
            // Cross-vendor surface: carry the owning org so the identity column
            // renders `Org/Source` ("who ships this"). Feed-mode callers leave
            // this unset because the org is already established in context.
            orgName: r.orgName ?? null,
            orgSlug: r.orgSlug ?? null,
            // TTY ≥4 glyph via importanceMarker(), same as tail/latest.
            // Wire field from monorepo #2135 (api-types ≥ 0.48.0).
            importance: r.importance ?? null,
          }));
          console.log(renderReleaseRows(rows, { mode: "search" }));
          console.log();
          totalResults += response.releases.length;
        }

        if (totalResults === 0) console.log(chalk.yellow("No results found."));
        else console.log(chalk.dim(`${totalResults} result(s) found.`));
      },
    );
}
