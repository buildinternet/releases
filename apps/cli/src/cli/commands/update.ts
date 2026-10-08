import { Command } from "commander";
import chalk from "chalk";
import { findOrg, createOrg } from "../../api/orgs.js";
import { findProduct } from "../../api/products.js";
import { findSource, updateSource, updateSourceMeta } from "../../api/sources.js";
import { sourceNotFound } from "../suggest.js";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isValidKind, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";
import { SOURCE_TYPES, SOURCE_DISCOVERY } from "@buildinternet/releases-core/source-enums";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { readContentArg, readJsonInputArg } from "../../lib/input.js";
import { CliError } from "../../lib/errors.js";
import { parseMetadataSetFlag } from "../../lib/flags.js";
import { buildNoticePatch } from "../../lib/notice.js";

function inferFeedTypeFromUrl(url: string): "rss" | "atom" | "jsonfeed" {
  const lower = url.toLowerCase();
  if (lower.endsWith(".json") || lower.includes("feed.json")) return "jsonfeed";
  if (lower.includes("atom")) return "atom";
  return "rss";
}

export type UpdateSourceOpts = {
  name?: string;
  url?: string;
  type?: string;
  slug?: string;
  confirmSlugChange?: boolean;
  org?: string | boolean;
  product?: string | boolean;
  feedUrl?: string | boolean;
  json?: boolean;
  markdownUrl?: string;
  provider?: string;
  fetchMethod?: string;
  parseInstructions?: boolean;
  parseInstructionsFile?: string;
  categoryAllow?: string | boolean;
  render?: boolean;
  primary?: boolean;
  priority?: string;
  disable?: boolean;
  enable?: boolean;
  changelogPaths?: string | boolean;
  kind?: string | boolean;
  discovery?: string;
  notice?: string;
  noticeLink?: string;
  noticeLinkText?: string;
  clearNotice?: boolean;
  dryRun?: boolean;
  metadataSet?: string[];
  metadataUnset?: string[];
  /** Raw JSON body (literal, `@file`, or `-` for stdin) → these update fields. */
  input?: string;
  /**
   * Convenience metadata patch from a `--input` body: each entry sets a source
   * `metadata` key directly (a JSON `null` value deletes it). Distinct from the
   * `metadataSet`/`metadataUnset` string-token flags, which it complements.
   */
  metadata?: Record<string, unknown>;
};

// Match the API worker cap (CHANGELOG_MAX_FILES) so we fail fast instead of
// silently dropping the tail at fetch time.
const CHANGELOG_PATHS_MAX = 20;

/**
 * Parse a `--changelog-paths` value into a non-empty, capped list of paths.
 * Exits the process with a friendly error on empty input or overflow so
 * callers don't have to repeat the same two checks inline.
 */
function parseChangelogPathsFlag(value: string): string[] {
  const paths = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (paths.length === 0) {
    logger.error(
      "--changelog-paths requires at least one path (use --no-changelog-paths to clear)",
    );
    process.exit(1);
  }
  if (paths.length > CHANGELOG_PATHS_MAX) {
    logger.error(
      `--changelog-paths accepts at most ${CHANGELOG_PATHS_MAX} entries (got ${paths.length})`,
    );
    process.exit(1);
  }
  return paths;
}

/** Shared action for both the canonical `update` command and the deprecated `edit` alias. */
export async function updateSourceAction(
  identifier: string,
  opts: UpdateSourceOpts,
): Promise<void> {
  // Raw-payload path (#324 item 3): a `--input` JSON body provides the field
  // updates directly, so an agent doesn't have to reverse-map onto a dozen
  // bespoke flags. The body merges over the CLI flags (body wins); `--json` and
  // `--dry-run` stay execution modifiers from the CLI and are never read from
  // the body. A nested `metadata` object is the ergonomic equivalent of repeated
  // `--metadata-set`/`--metadata-unset` (a `null` value deletes the key).
  if (opts.input !== undefined) {
    const body = await readJsonInputArg(opts.input);
    if (Array.isArray(body) || body === null || typeof body !== "object") {
      throw new CliError("--input must be a JSON object mapping update fields.");
    }
    const { metadata, json: _json, dryRun: _dryRun, ...fields } = body as Record<string, unknown>;
    opts = { ...opts, ...(fields as UpdateSourceOpts) };
    if (metadata !== undefined) {
      if (Array.isArray(metadata) || metadata === null || typeof metadata !== "object") {
        throw new CliError('--input "metadata" must be a JSON object of key/value pairs.');
      }
      opts.metadata = metadata as Record<string, unknown>;
    }
  }

  // Validate enumerated options before any network call so errors surface fast.
  if (
    opts.discovery !== undefined &&
    !(SOURCE_DISCOVERY as readonly string[]).includes(opts.discovery)
  ) {
    logger.error(
      `Invalid discovery "${opts.discovery}". Must be one of: ${SOURCE_DISCOVERY.join(", ")}`,
    );
    process.exit(1);
  }

  // `--no-parse-instructions` produces `false` (boolean); `--parse-instructions-file`
  // provides the content string. An empty file clears (matches the empty-string case).
  const parseInstructions: string | false | undefined =
    opts.parseInstructions === false
      ? false
      : opts.parseInstructionsFile !== undefined
        ? await readContentArg(opts.parseInstructionsFile)
        : undefined;

  const source = await findSource(identifier);
  if (!source) return sourceNotFound(identifier);

  if (opts.type && !(SOURCE_TYPES as readonly string[]).includes(opts.type)) {
    console.error(
      chalk.red(`Invalid type "${opts.type}". Must be one of: ${SOURCE_TYPES.join(", ")}`),
    );
    process.exit(1);
  }

  const VALID_METHODS = ["feed", "markdown", "scrape", "crawl", "github"];
  if (opts.fetchMethod && !VALID_METHODS.includes(opts.fetchMethod)) {
    console.error(
      chalk.red(
        `Invalid fetch method "${opts.fetchMethod}". Must be one of: ${VALID_METHODS.join(", ")}`,
      ),
    );
    process.exit(1);
  }

  if (opts.slug && !opts.confirmSlugChange) {
    console.error(chalk.red("Slug changes break existing web links and bookmarks."));
    console.error(chalk.yellow(`  Current: releases.sh/${source.slug}`));
    console.error(chalk.yellow(`  New:     releases.sh/${opts.slug}`));
    console.error(`\nAdd ${chalk.bold("--confirm-slug-change")} to proceed.`);
    process.exit(1);
  }

  const updates: Record<string, unknown> = {};
  const changes: string[] = [];

  if (opts.name) {
    updates.name = opts.name;
    changes.push(`name → ${opts.name}`);
  }
  if (opts.url) {
    updates.url = opts.url;
    changes.push(`url → ${opts.url}`);
  }
  if (opts.type) {
    updates.type = opts.type;
    changes.push(`type → ${opts.type}`);
  }
  if (opts.slug) {
    updates.slug = opts.slug;
    changes.push(`slug → ${opts.slug}`);
  }

  if (opts.org === false) {
    updates.orgId = null;
    changes.push("org removed");
  } else if (typeof opts.org === "string") {
    let org = await findOrg(opts.org);
    if (!org) {
      // Don't auto-create when the operator passed a typed ID — an unresolved
      // `org_…` is a typo, not a request to spin up a new org. Same logic for
      // an `org/slug` coordinate fragment, which can't sensibly be a new name.
      if (opts.org.startsWith("org_") || opts.org.includes("/")) {
        console.error(chalk.red(`Organization not found: ${opts.org}`));
        process.exit(1);
      }
      if (opts.dryRun) {
        const projectedSlug = toSlug(opts.org);
        logger.info(`[dry-run] Would create organization: ${opts.org} (${projectedSlug})`);
        changes.push(`org → ${opts.org} (would be created)`);
      } else {
        org = await createOrg(opts.org, { slug: toSlug(opts.org) });
        logger.info(`Created organization: ${org.name} (${org.slug})`);
        updates.orgId = org.id;
        changes.push(`org → ${org.name}`);
      }
    } else {
      updates.orgId = org.id;
      changes.push(`org → ${org.name}`);
    }
  }

  if (opts.product === false) {
    updates.productId = null;
    changes.push("product removed");
  } else if (typeof opts.product === "string") {
    const prod = await findProduct(opts.product);
    if (!prod) {
      console.error(chalk.red(`Product not found: ${opts.product}`));
      process.exit(1);
    }
    updates.productId = prod.id;
    changes.push(`product → ${prod.name}`);
  }

  if (opts.primary !== undefined) {
    updates.isPrimary = opts.primary;
    changes.push(opts.primary ? "marked as primary" : "unmarked as primary");
  }

  if (opts.priority) {
    const validPriorities = ["normal", "low", "paused"];
    if (!validPriorities.includes(opts.priority)) {
      console.error(
        chalk.red(
          `Invalid priority "${opts.priority}". Must be one of: ${validPriorities.join(", ")}`,
        ),
      );
      process.exit(1);
    }
    updates.fetchPriority = opts.priority;
    changes.push(`priority → ${opts.priority}`);
  }

  if (opts.disable) {
    updates.isHidden = true;
    changes.push("disabled");
  } else if (opts.enable) {
    updates.isHidden = false;
    changes.push("enabled");
  }

  if (opts.kind === false) {
    updates.kind = null;
    changes.push("kind cleared");
  } else if (typeof opts.kind === "string") {
    if (!isValidKind(opts.kind)) {
      logger.error(`Invalid kind "${opts.kind}". Must be one of: ${KIND_VALUES.join(", ")}`);
      process.exit(1);
    }
    updates.kind = opts.kind satisfies Kind;
    changes.push(`kind → ${opts.kind}`);
  }

  if (opts.discovery !== undefined) {
    updates.discovery = opts.discovery;
    changes.push(`discovery → ${opts.discovery}`);
  }

  const metaUpdates: Record<string, unknown> = {};

  if (opts.feedUrl === false) {
    Object.assign(metaUpdates, {
      feedUrl: undefined,
      feedType: undefined,
      feedDiscoveredAt: undefined,
      noFeedFound: true,
    });
    changes.push("feed URL removed (feed discovery disabled)");
  } else if (typeof opts.feedUrl === "string") {
    const feedType = inferFeedTypeFromUrl(opts.feedUrl);
    Object.assign(metaUpdates, {
      feedUrl: opts.feedUrl,
      feedType,
      feedDiscoveredAt: new Date().toISOString(),
      noFeedFound: false,
    });
    changes.push(`feed URL → ${opts.feedUrl} (${feedType})`);
  }

  if (opts.markdownUrl) {
    metaUpdates.markdownUrl = opts.markdownUrl;
    changes.push(`markdown URL → ${opts.markdownUrl}`);
  }

  if (opts.provider) {
    metaUpdates.provider = opts.provider;
    metaUpdates.providerDetectedAt = new Date().toISOString();
    changes.push(`provider → ${opts.provider}`);
  }

  if (opts.fetchMethod) {
    metaUpdates.evaluatedMethod = opts.fetchMethod;
    metaUpdates.evaluatedAt = new Date().toISOString();
    changes.push(`fetch method → ${opts.fetchMethod}`);
  }

  if (parseInstructions === false || parseInstructions === "") {
    metaUpdates.parseInstructions = undefined;
    changes.push("parse instructions removed");
  } else if (typeof parseInstructions === "string") {
    metaUpdates.parseInstructions = parseInstructions;
    const preview =
      parseInstructions.length > 60 ? `${parseInstructions.slice(0, 60)}...` : parseInstructions;
    changes.push(`parse instructions → "${preview}"`);
  }

  if (opts.categoryAllow === false) {
    metaUpdates.categoryAllow = undefined;
    changes.push("category allowlist removed");
  } else if (typeof opts.categoryAllow === "string") {
    const allow = opts.categoryAllow
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (allow.length === 0) {
      logger.error(
        "--category-allow requires at least one category (use --no-category-allow to clear)",
      );
      process.exit(1);
    }
    metaUpdates.categoryAllow = allow;
    changes.push(`category allowlist → ${allow.join(", ")}`);
  }

  if (opts.render === true) {
    metaUpdates.renderRequired = true;
    changes.push("rendering → required (headless browser)");
  } else if (opts.render === false) {
    metaUpdates.renderRequired = false;
    changes.push("rendering → disabled (fast fetch)");
  }

  if (opts.changelogPaths === false) {
    metaUpdates.changelogPaths = undefined;
    changes.push("changelog paths cleared (auto-discovery only)");
  } else if (typeof opts.changelogPaths === "string") {
    const paths = parseChangelogPathsFlag(opts.changelogPaths);
    metaUpdates.changelogPaths = paths;
    changes.push(`changelog paths → ${paths.length} path(s) [${paths.join(", ")}]`);
  }

  // --metadata-set / --metadata-unset
  // When the same key appears in both, unset runs first so that a set on the
  // same key in the same invocation is a no-op (users should avoid it, but
  // last-write-wins is documented so we honour it via iteration order).
  if (opts.metadataUnset && opts.metadataUnset.length > 0) {
    for (const key of opts.metadataUnset) {
      if (key.trim() === "") {
        logger.error(`Invalid --metadata-unset key: key must be non-empty`);
        process.exit(2);
      }
      if (key.includes(".") || key.includes("[")) {
        logger.error(
          `Invalid --metadata-unset key "${key}": nested paths (keys containing "." or "[") are not supported.`,
        );
        process.exit(2);
      }
      metaUpdates[key] = undefined;
      changes.push(`metadata.${key} removed`);
    }
  }

  if (opts.metadataSet && opts.metadataSet.length > 0) {
    for (const token of opts.metadataSet) {
      const [key, value] = parseMetadataSetFlag(token);
      metaUpdates[key] = value;
      const preview = JSON.stringify(value);
      changes.push(
        `metadata.${key} → ${preview.length > 60 ? preview.slice(0, 60) + "..." : preview}`,
      );
    }
  }

  // `--input` metadata object: set each key directly (values keep their JSON
  // type — no key=value coercion), with a `null` value deleting the key
  // (`updateSourceMeta` treats `undefined` as delete). Runs after the token
  // flags so an explicit object wins on a colliding key.
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      if (key.trim() === "" || key.includes(".") || key.includes("[")) {
        logger.error(
          `Invalid metadata key "${key}": keys must be non-empty and may not contain "." or "[".`,
        );
        process.exit(2);
      }
      if (value === null) {
        metaUpdates[key] = undefined;
        changes.push(`metadata.${key} removed`);
      } else {
        metaUpdates[key] = value;
        const preview = JSON.stringify(value);
        changes.push(
          `metadata.${key} → ${preview.length > 60 ? preview.slice(0, 60) + "..." : preview}`,
        );
      }
    }
  }

  const noticePatch = buildNoticePatch(opts, logger);
  if (noticePatch !== null) {
    updates.notice = noticePatch.notice;
    changes.push(noticePatch.notice === null ? "notice cleared" : `notice → "${opts.notice}"`);
  }

  if (changes.length === 0) {
    if (!opts.json) logger.warn("No changes specified. Use --help to see options.");
    return;
  }

  if (opts.dryRun) {
    if (opts.json)
      await writeJson(
        markDryRun({
          wouldUpdate: source.slug,
          name: source.name,
          updates,
          metaUpdates,
          changes,
        }),
      );
    else {
      logger.warn(`[dry-run] Would update ${source.name} (${source.slug}):`);
      for (const change of changes) logger.warn(`  ${change}`);
    }
    return;
  }

  if (Object.keys(metaUpdates).length > 0) {
    await updateSourceMeta(source, metaUpdates);
  }

  let updated: Awaited<ReturnType<typeof updateSource>> | undefined;
  if (Object.keys(updates).length > 0) {
    updated = await updateSource(source, updates);
    if (opts.slug && updated.slug !== opts.slug) {
      const idx = changes.findIndex((c) => c.startsWith("slug →"));
      if (idx !== -1) changes.splice(idx, 1);
      logger.warn(`Slug was not updated (API returned slug="${updated.slug}")`);
    }
  }

  const displaySlug = updated?.slug ?? source.slug;

  if (opts.json) {
    // Refresh through the globally-unique typed id, never the (possibly
    // colliding) bare slug. A slug like `release-notes` matches sources in many
    // orgs, so `findSource(displaySlug)` would throw AmbiguousSourceError here —
    // *after* the update already applied — even though the source was addressed
    // by an unambiguous `src_…` id (#294).
    const refreshed = await findSource(updated?.id ?? source.id);
    await writeJson(refreshed);
  } else {
    logger.info(chalk.green(`Updated ${source.name} (${displaySlug}):`));
    for (const change of changes) logger.info(`  ${change}`);
  }
}

export function attachUpdateOptions(cmd: Command): Command {
  return cmd
    .argument("<identifier>", "Source ID (src_…), org/slug coordinate, or slug")
    .option("--name <name>", "Update display name")
    .option("--url <url>", "Update source URL")
    .option("--type <type>", "Update source type (github, scrape, feed, agent)")
    .option("--slug <newSlug>", "Update slug (requires --confirm-slug-change; breaks web links)")
    .option("--confirm-slug-change", "Confirm slug rename")
    .option("--org <org>", "Set organization (org_…, slug, domain, name, or handle)")
    .option("--no-org", "Remove organization association")
    .option("--product <product>", "Set product (prod_… or slug)")
    .option("--no-product", "Remove product association")
    .option("--feed-url <feedUrl>", "Set or update the feed URL")
    .option("--no-feed-url", "Remove stored feed URL")
    .option("--markdown-url <markdownUrl>", "Set the raw markdown URL for this source")
    .option(
      "--parse-instructions-file <path>",
      "Path to file with AI parsing instructions (use - for stdin; empty file clears)",
    )
    .option("--no-parse-instructions", "Remove AI parsing instructions")
    .option(
      "--category-allow <list>",
      "Comma-separated allowlist of feed `<category>` values to keep (case-insensitive). Items whose categories don't intersect — and items with no category at all — are dropped at ingest. Example: 'Product,Release'",
    )
    .option("--no-category-allow", "Remove the feed category allowlist")
    .option("--render", "Force headless browser rendering for this source")
    .option("--no-render", "Allow fast fetch without headless browser rendering")
    .option("--provider <provider>", "Set the detected provider")
    .option("--fetch-method <fetchMethod>", "Set the recommended fetch method")
    .option("--primary", "Mark as the org's primary changelog source")
    .option("--no-primary", "Unmark as primary")
    .option("--priority <level>", "Set fetch priority (normal, low, paused)")
    .option("--disable", "Disable source")
    .option("--enable", "Re-enable a disabled source")
    .option(
      "--kind <kind>",
      `Set source taxonomy (${KIND_VALUES.join(", ")}). Resolves through the parent product on content-oriented surfaces (releases feed, search release hits) and matches directly on metadata surfaces (lists, catalog).`,
    )
    .option("--no-kind", "Clear the source's kind (falls back to inheriting from parent product)")
    .option(
      "--discovery <status>",
      `Promote/demote discovery status (${SOURCE_DISCOVERY.join(" | ")})`,
    )
    .option(
      "--changelog-paths <paths>",
      "Comma-separated list of CHANGELOG paths (relative to repo root) for monorepo sources, e.g. 'packages/core/CHANGELOG.md,packages/cli/CHANGELOG.md'",
    )
    .option("--no-changelog-paths", "Clear the changelog paths override (return to auto-discovery)")
    .option(
      "--metadata-set <key=value>",
      "Set a source metadata key. Repeatable; if the same key appears more than once, the last value wins. " +
        "Value coercion: true/false/null → JSON literal; finite number string → number; " +
        "value starting with { or [ → parsed as JSON; otherwise → string. " +
        'Keys containing "." or "[" are rejected (use --metadata-set key=\'{"nested":"value"}\' for objects).',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option(
      "--metadata-unset <key>",
      'Delete a source metadata key. Repeatable. Keys containing "." or "[" are rejected.',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option("--notice <message>", "Set a curator notice on this source (max 280 chars)")
    .option(
      "--notice-link <coordinate|url>",
      "Optional pointer: registry coordinate (org/slug) or https:// URL",
    )
    .option(
      "--notice-link-text <label>",
      "Optional link label for the notice pointer (max 60 chars)",
    )
    .option("--clear-notice", "Remove the notice from this source")
    .option(
      "--input <json>",
      "Raw JSON body of field updates (keys mirror the flags: name, url, type, org, " +
        'product, kind, priority, discovery, primary, …). A nested "metadata" object sets ' +
        "source metadata keys directly (a null value deletes a key). Pass a literal JSON string, " +
        "@<path> for a file, or - for stdin. The body wins over flags; --json/--dry-run still apply.",
    )
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing");
}

export function registerUpdateCommand(program: Command) {
  attachUpdateOptions(program.command("update").description("Update an existing changelog source"))
    .addHelpText(
      "after",
      `
Examples:
  releases admin source update vercel/next-js --kind sdk
  releases admin source update src_abc123 --primary
  releases admin source update src_abc123 --parse-instructions-file parse.md
  cat parse.md | releases admin source update src_abc123 --parse-instructions-file -
  releases admin source update redis-software-release-notes \\
    --metadata-set crawlEnabled=true \\
    --metadata-set crawlIncludePathPrefix=/docs/latest/operate/rs/release-notes/
  releases admin source update docker-compose-release-notes \\
    --metadata-set githubUrl=https://github.com/docker/compose
  releases admin source update some-source --metadata-unset legacyFlag
  releases admin source update src_abc123 --input '{"kind":"sdk","priority":"low","metadata":{"crawlEnabled":true}}'
  releases admin source update src_abc123 --input @patch.json`,
    )
    .action(updateSourceAction);
}
