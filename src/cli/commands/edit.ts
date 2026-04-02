import { Command } from "commander";
import chalk from "chalk";
import { findSourceBySlug, findOrg, createOrg, updateSource } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";
import { updateSourceMeta } from "../../adapters/feed.js";

const VALID_TYPES = ["github", "scrape", "feed", "agent"] as const;

function inferFeedTypeFromUrl(url: string): "rss" | "atom" | "jsonfeed" {
  const lower = url.toLowerCase();
  if (lower.endsWith(".json") || lower.includes("feed.json")) return "jsonfeed";
  if (lower.includes("atom")) return "atom";
  return "rss"; // safe default — RSS parser handles most XML feeds
}

export function registerEditCommand(program: Command) {
  program
    .command("edit")
    .description("Edit an existing changelog source")
    .argument("<slug>", "Slug of the source to edit")
    .option("--name <name>", "Update display name")
    .option("--url <url>", "Update source URL")
    .option("--type <type>", "Update source type (github, scrape, feed, agent)")
    .option("--slug <newSlug>", "Update slug")
    .option("--org <org>", "Set organization (name or slug, creates if not found)")
    .option("--no-org", "Remove organization association")
    .option("--feed-url <feedUrl>", "Set or update the feed URL")
    .option("--no-feed-url", "Remove stored feed URL")
    .option("--markdown-url <markdownUrl>", "Set the raw markdown URL for this source")
    .option("--provider <provider>", "Set the detected provider (e.g., mintlify, docusaurus)")
    .option("--fetch-method <fetchMethod>", "Set the recommended fetch method (feed, markdown, scrape, crawl, github)")
    .option("--primary", "Mark as the org's primary changelog source")
    .option("--no-primary", "Unmark as primary")
    .option("--hidden", "Hide source from default list/search results")
    .option("--no-hidden", "Unhide source (restore to default visibility)")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released edit my-source --name "New Name"
  released edit my-source --url https://example.com/new-changelog
  released edit my-source --org "Acme Corp"
  released edit my-source --primary
  released edit my-source --feed-url https://example.com/feed.xml
  released edit my-source --markdown-url https://example.com/changelog.md
  released edit my-source --fetch-method markdown
  released edit my-source --hidden
  released edit my-source --no-hidden
  released edit my-source --no-org`)
    .action(async (slug: string, opts: {
      name?: string; url?: string; type?: string; slug?: string;
      org?: string | boolean; feedUrl?: string | boolean; json?: boolean;
      markdownUrl?: string; provider?: string; fetchMethod?: string;
      primary?: boolean;
      hidden?: boolean;
    }) => {
      const source = await findSourceBySlug(slug);
      if (!source) {
        console.error(chalk.red(`Source not found: ${slug}`));
        process.exit(1);
      }

      if (opts.type && !(VALID_TYPES as readonly string[]).includes(opts.type)) {
        console.error(chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`));
        process.exit(1);
      }

      const VALID_METHODS = ["feed", "markdown", "scrape", "crawl", "github"];
      if (opts.fetchMethod && !VALID_METHODS.includes(opts.fetchMethod)) {
        console.error(chalk.red(`Invalid fetch method "${opts.fetchMethod}". Must be one of: ${VALID_METHODS.join(", ")}`));
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

      // Handle --primary / --no-primary
      if (opts.primary !== undefined) {
        updates.isPrimary = opts.primary;
        changes.push(opts.primary ? "marked as primary" : "unmarked as primary");
      }

      // Handle --hidden / --no-hidden
      if (opts.hidden !== undefined) {
        updates.isHidden = opts.hidden;
        changes.push(opts.hidden ? "marked as hidden" : "unmarked as hidden");
      }

      // Accumulate metadata updates for a single write
      const metaUpdates: Record<string, unknown> = {};

      // Handle --feed-url / --no-feed-url
      if (opts.feedUrl === false) {
        Object.assign(metaUpdates, { feedUrl: undefined, feedType: undefined, feedDiscoveredAt: undefined });
        changes.push("feed URL removed");
      } else if (typeof opts.feedUrl === "string") {
        const feedType = inferFeedTypeFromUrl(opts.feedUrl);
        Object.assign(metaUpdates, { feedUrl: opts.feedUrl, feedType, feedDiscoveredAt: new Date().toISOString(), noFeedFound: false });
        changes.push(`feed URL → ${opts.feedUrl} (${feedType})`);
      }

      // Handle --markdown-url
      if (opts.markdownUrl) {
        metaUpdates.markdownUrl = opts.markdownUrl;
        changes.push(`markdown URL → ${opts.markdownUrl}`);
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

      if (Object.keys(metaUpdates).length > 0) {
        await updateSourceMeta(source, metaUpdates);
      }

      if (Object.keys(updates).length > 0) {
        await updateSource(source, updates);
      }

      if (changes.length === 0) {
        console.log(chalk.yellow("No changes specified. Use --help to see options."));
        return;
      }

      const displaySlug = opts.slug ?? slug;

      if (opts.json) {
        const updated = await findSourceBySlug(displaySlug);
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(chalk.green(`Updated ${source.name} (${displaySlug}):`));
        for (const change of changes) {
          console.log(`  ${change}`);
        }
      }
    });
}
