import { Command } from "commander";
import { eq } from "drizzle-orm";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { sources, organizations } from "../../db/schema.js";
import { findOrg } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";
import { updateSourceMeta } from "../../adapters/feed.js";

const VALID_TYPES = ["github", "scrape", "feed"] as const;

export function registerEditCommand(program: Command) {
  program
    .command("edit")
    .description("Edit an existing changelog source")
    .argument("<slug>", "Slug of the source to edit")
    .option("--name <name>", "Update display name")
    .option("--url <url>", "Update source URL")
    .option("--type <type>", "Update source type (github, scrape, feed)")
    .option("--slug <newSlug>", "Update slug")
    .option("--org <org>", "Set organization (name or slug, creates if not found)")
    .option("--no-org", "Remove organization association")
    .option("--feed-url <feedUrl>", "Set or update the feed URL")
    .option("--no-feed-url", "Remove stored feed URL")
    .action(async (slug: string, opts: {
      name?: string; url?: string; type?: string; slug?: string;
      org?: string | boolean; feedUrl?: string | boolean;
    }) => {
      const db = getDb();

      const [source] = await db.select().from(sources).where(eq(sources.slug, slug));
      if (!source) {
        console.error(chalk.red(`Source not found: ${slug}`));
        process.exit(1);
      }

      if (opts.type && !(VALID_TYPES as readonly string[]).includes(opts.type)) {
        console.error(chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`));
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
          const orgSlug = toSlug(opts.org);
          const now = new Date().toISOString();
          const [created] = await db.insert(organizations).values({
            name: opts.org,
            slug: orgSlug,
            createdAt: now,
            updatedAt: now,
          }).returning();
          org = created;
          logger.info(`Created organization: ${org.name} (${org.slug})`);
        }
        updates.orgId = org.id;
        changes.push(`org → ${org.name}`);
      }

      // Handle --feed-url / --no-feed-url
      if (opts.feedUrl === false) {
        await updateSourceMeta(source, { feedUrl: undefined, feedType: undefined, feedDiscoveredAt: undefined });
        changes.push("feed URL removed");
      } else if (typeof opts.feedUrl === "string") {
        await updateSourceMeta(source, {
          feedUrl: opts.feedUrl,
          feedType: "unknown" as any,
          feedDiscoveredAt: new Date().toISOString(),
          noFeedFound: false,
        });
        changes.push(`feed URL → ${opts.feedUrl}`);
      }

      if (Object.keys(updates).length > 0) {
        await db.update(sources).set(updates).where(eq(sources.id, source.id));
      }

      if (changes.length === 0) {
        console.log(chalk.yellow("No changes specified. Use --help to see options."));
        return;
      }

      const displaySlug = opts.slug ?? slug;
      console.log(chalk.green(`Updated ${source.name} (${displaySlug}):`));
      for (const change of changes) {
        console.log(`  ${change}`);
      }
    });
}
