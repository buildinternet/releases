import { Command } from "commander";
import chalk from "chalk";
import { findSource, findOrg, createOrg, updateSource, findProduct } from "../../db/queries.js";
import { sourceNotFound } from "../suggest.js";
import { toSlug } from "@releases/core-internal/slug";
import { logger } from "@buildinternet/releases-lib/logger";
import { updateSourceMeta, CLEARED_FEED_FIELDS } from "../../adapters/feed.js";

import {
  VALID_FEED_TYPES,
  resolveFeedUpdate,
  resolveFetchUrlUpdate,
} from "../../lib/source-edit.js";

const VALID_TYPES = ["github", "scrape", "feed", "agent"] as const;

export function registerEditCommand(program: Command) {
  program
    .command("edit")
    .description("Edit an existing changelog source")
    .argument("<identifier>", "Source ID (src_...) or slug")
    .option("--name <name>", "Update display name")
    .option("--url <url>", "Update source URL")
    .option("--type <type>", "Update source type (github, scrape, feed, agent)")
    .option("--slug <newSlug>", "Update slug (requires --confirm-slug-change; breaks web links)")
    .option("--confirm-slug-change", "Confirm slug rename (slug changes break existing web links)")
    .option("--org <org>", "Set organization (name or slug, creates if not found)")
    .option("--no-org", "Remove organization association")
    .option("--product <product>", "Set product (slug)")
    .option("--no-product", "Remove product association")
    .option("--feed-url <feedUrl>", "Set or update the feed URL")
    .option("--no-feed-url", "Remove stored feed URL")
    .option(
      "--feed-type <feedType>",
      `Override inferred feed type (one of: ${VALID_FEED_TYPES.join(", ")}). Requires --feed-url.`,
    )
    .option("--markdown-url <markdownUrl>", "Set the raw markdown URL for this source")
    .option(
      "--fetch-url <fetchUrl>",
      "Set a direct-fetch URL for the agent adapter (JSON, markdown, HTML — body is handed to the AI)",
    )
    .option("--no-fetch-url", "Remove the direct-fetch URL")
    .option("--parse-instructions <text>", "Set AI parsing instructions for this source")
    .option("--no-parse-instructions", "Remove AI parsing instructions")
    .option("--render", "Force headless browser rendering for this source")
    .option("--no-render", "Allow fast fetch without headless browser rendering")
    .option("--provider <provider>", "Set the detected provider (e.g., mintlify, docusaurus)")
    .option(
      "--fetch-method <fetchMethod>",
      "Set the recommended fetch method (feed, markdown, scrape, crawl, github)",
    )
    .option("--primary", "Mark as the org's primary changelog source")
    .option("--no-primary", "Unmark as primary")
    .option("--priority <level>", "Set fetch priority (normal, low, paused)")
    .option("--disable", "Disable source (excluded from fetch, search, and stats)")
    .option("--enable", "Re-enable a disabled source")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source edit src_abc123 --name "New Name"
  releases admin source edit my-source --name "New Name"
  releases admin source edit my-source --url https://example.com/new-changelog
  releases admin source edit my-source --org "Acme Corp"
  releases admin source edit my-source --primary
  releases admin source edit my-source --feed-url https://example.com/feed.xml
  releases admin source edit my-source --feed-url https://example.com/changelog/rss --feed-type rss
  releases admin source edit my-source --markdown-url https://example.com/changelog.md
  releases admin source edit my-source --fetch-method markdown
  releases admin source edit my-source --priority low
  releases admin source edit my-source --disable
  releases admin source edit my-source --enable
  releases admin source edit my-source --slug new-slug --confirm-slug-change
  releases admin source edit my-source --no-org`,
    )
    .action(
      async (
        identifier: string,
        opts: {
          name?: string;
          url?: string;
          type?: string;
          slug?: string;
          confirmSlugChange?: boolean;
          org?: string | boolean;
          product?: string | boolean;
          feedUrl?: string | boolean;
          feedType?: string;
          json?: boolean;
          markdownUrl?: string;
          fetchUrl?: string | boolean;
          provider?: string;
          fetchMethod?: string;
          parseInstructions?: string | boolean;
          render?: boolean;
          primary?: boolean;
          priority?: string;
          disable?: boolean;
          enable?: boolean;
        },
      ) => {
        const source = await findSource(identifier);
        if (!source) {
          return sourceNotFound(identifier);
        }

        if (opts.type && !(VALID_TYPES as readonly string[]).includes(opts.type)) {
          console.error(
            chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`),
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

        // Slug changes break web links — require explicit confirmation
        if (opts.slug && !opts.confirmSlugChange) {
          console.error(chalk.red("Slug changes break existing web links and bookmarks."));
          console.error(chalk.yellow(`  Current: releases.sh/${source.slug}`));
          console.error(chalk.yellow(`  New:     releases.sh/${opts.slug}`));
          console.error("");
          console.error(`Add ${chalk.bold("--confirm-slug-change")} to proceed.`);
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

        // Handle --org / --no-org
        if (opts.org === false) {
          updates.orgId = null;
          changes.push("org removed");
        } else if (typeof opts.org === "string") {
          let org = await findOrg(opts.org);
          if (!org) {
            org = await createOrg(opts.org, { slug: toSlug(opts.org) });
            logger.info(`Created organization: ${org.name} (${org.slug})`);
          }
          updates.orgId = org.id;
          changes.push(`org → ${org.name}`);
        }

        // Handle --product / --no-product
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

        // Handle --primary / --no-primary
        if (opts.primary !== undefined) {
          updates.isPrimary = opts.primary;
          changes.push(opts.primary ? "marked as primary" : "unmarked as primary");
        }

        // Handle --priority
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

        // Handle --disable / --enable
        if (opts.disable) {
          updates.isHidden = true;
          changes.push("disabled");
        } else if (opts.enable) {
          updates.isHidden = false;
          changes.push("enabled");
        }

        // Accumulate metadata updates for a single write
        const metaUpdates: Record<string, unknown> = {};

        // Handle --feed-url / --no-feed-url / --feed-type
        const feedResolution = resolveFeedUpdate({
          feedUrl: opts.feedUrl,
          feedType: opts.feedType,
        });
        if (!feedResolution.ok) {
          console.error(chalk.red(feedResolution.error));
          process.exit(1);
        }
        if (feedResolution.action === "remove") {
          Object.assign(metaUpdates, CLEARED_FEED_FIELDS, { noFeedFound: true });
          changes.push("feed URL removed (feed discovery disabled)");
        } else if (feedResolution.action === "set") {
          Object.assign(metaUpdates, CLEARED_FEED_FIELDS, {
            feedUrl: feedResolution.feedUrl,
            feedType: feedResolution.feedType,
            feedDiscoveredAt: new Date().toISOString(),
            noFeedFound: false,
          });
          changes.push(`feed URL → ${feedResolution.feedUrl} (${feedResolution.feedType})`);
        }

        // Handle --markdown-url
        if (opts.markdownUrl) {
          metaUpdates.markdownUrl = opts.markdownUrl;
          changes.push(`markdown URL → ${opts.markdownUrl}`);
        }

        // Handle --fetch-url / --no-fetch-url
        const fetchResolution = resolveFetchUrlUpdate({ fetchUrl: opts.fetchUrl });
        if (fetchResolution.action === "remove") {
          Object.assign(metaUpdates, {
            fetchUrl: undefined,
            fetchEtag: undefined,
            fetchLastModified: undefined,
          });
          changes.push("fetch URL removed");
        } else if (fetchResolution.action === "set") {
          Object.assign(metaUpdates, {
            fetchUrl: fetchResolution.fetchUrl,
            fetchEtag: undefined,
            fetchLastModified: undefined,
          });
          changes.push(`fetch URL → ${fetchResolution.fetchUrl}`);
        }

        // Handle --provider
        if (opts.provider) {
          metaUpdates.provider = opts.provider;
          metaUpdates.providerDetectedAt = new Date().toISOString();
          changes.push(`provider → ${opts.provider}`);
        }

        // Handle --fetch-method
        if (opts.fetchMethod) {
          metaUpdates.evaluatedMethod = opts.fetchMethod;
          metaUpdates.evaluatedAt = new Date().toISOString();
          changes.push(`fetch method → ${opts.fetchMethod}`);
        }

        // Handle --parse-instructions / --no-parse-instructions
        // Treat empty string the same as --no-parse-instructions
        if (opts.parseInstructions === false || opts.parseInstructions === "") {
          metaUpdates.parseInstructions = undefined;
          changes.push("parse instructions removed");
        } else if (typeof opts.parseInstructions === "string") {
          metaUpdates.parseInstructions = opts.parseInstructions;
          changes.push(
            `parse instructions → "${opts.parseInstructions.slice(0, 60)}${opts.parseInstructions.length > 60 ? "..." : ""}"`,
          );
        }

        // Handle --render / --no-render
        if (opts.render === true) {
          metaUpdates.renderRequired = true;
          changes.push("rendering → required (headless browser)");
        } else if (opts.render === false) {
          metaUpdates.renderRequired = false;
          changes.push("rendering → disabled (fast fetch)");
        }

        if (Object.keys(metaUpdates).length > 0) {
          await updateSourceMeta(source, metaUpdates);
        }

        if (Object.keys(updates).length > 0) {
          const updated = await updateSource(source, updates);
          // Verify slug actually changed — the API may reject or ignore it
          if (opts.slug && updated.slug !== opts.slug) {
            const idx = changes.findIndex((c) => c.startsWith("slug →"));
            if (idx !== -1) changes.splice(idx, 1);
            logger.warn(`Slug was not updated (API returned slug="${updated.slug}")`);
          }
        }

        if (changes.length === 0) {
          console.log(chalk.yellow("No changes specified. Use --help to see options."));
          return;
        }

        const displaySlug = opts.slug ?? source.slug;

        if (opts.json) {
          const refreshed = await findSource(displaySlug);
          console.log(JSON.stringify(refreshed, null, 2));
        } else {
          console.log(chalk.green(`Updated ${source.name} (${displaySlug}):`));
          for (const change of changes) {
            console.log(`  ${change}`);
          }
        }
      },
    );
}
