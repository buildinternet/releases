import { Command } from "commander";
import chalk from "chalk";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, organizations, orgAccounts } from "../../db/schema.js";
import { findOrg } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";

const VALID_TYPES = ["github", "scrape"] as const;
type SourceType = (typeof VALID_TYPES)[number];

function isValidType(t: string): t is SourceType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

function parseGitHubOwner(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  return match ? match[1] : null;
}

export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("Add a new changelog source")
    .argument("<name>", "Display name for the source")
    .requiredOption("--type <type>", "Source type: github or scrape")
    .requiredOption("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization name or slug (creates if not found)")
    .action(async (name: string, opts: { type: string; url: string; slug?: string; org?: string }) => {
      if (!isValidType(opts.type)) {
        console.error(chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`));
        process.exit(1);
      }

      const slug = opts.slug ?? toSlug(name);
      const db = getDb();
      let orgId: string | null = null;
      let orgName: string | null = null;

      // Resolve or create org if --org provided
      if (opts.org) {
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
        orgId = org.id;
        orgName = org.name;
      }

      // Auto-association for GitHub sources (only if no --org specified)
      if (!opts.org && opts.type === "github") {
        const owner = parseGitHubOwner(opts.url);
        if (owner) {
          const [account] = await db
            .select({ orgId: orgAccounts.orgId, orgName: organizations.name })
            .from(orgAccounts)
            .innerJoin(organizations, eq(orgAccounts.orgId, organizations.id))
            .where(and(eq(orgAccounts.platform, "github"), eq(orgAccounts.handle, owner)));
          if (account) {
            orgId = account.orgId;
            orgName = account.orgName;
            logger.info(`Auto-linked to organization "${orgName}"`);
          }
        }
      }

      await db.insert(sources).values({
        name,
        slug,
        type: opts.type,
        url: opts.url,
        orgId,
      });

      const orgLabel = orgName ? ` [org: ${orgName}]` : "";
      console.log(chalk.green(`Source added: ${name} (${slug})${orgLabel}`));
    });
}
