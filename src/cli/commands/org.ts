import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, orgAccounts } from "../../db/schema.js";
import { findOrg, getSourcesByOrg, listOrgs } from "../../db/queries.js";
import { toSlug } from "../../lib/slug.js";

export function registerOrgCommand(program: Command) {
  const org = program
    .command("org")
    .description("Manage organizations");

  // ── org add ──
  org
    .command("add")
    .description("Add a new organization")
    .argument("<name>", "Organization name")
    .option("--domain <domain>", "Primary domain (e.g. vercel.com)")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { domain?: string; slug?: string; json?: boolean }) => {
      const db = getDb();
      const slug = opts.slug ?? toSlug(name);

      const existing = await findOrg(slug);
      if (existing) {
        console.error(chalk.red(`Organization with slug "${slug}" already exists.`));
        process.exit(1);
      }

      const now = new Date().toISOString();
      const [created] = await db.insert(organizations).values({
        name,
        slug,
        domain: opts.domain ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning();

      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(chalk.green(`Organization added: ${name} (${slug})`));
      }
    });

  // ── org list ──
  org
    .command("list")
    .description("List all organizations")
    .option("--query <text>", "Filter by name, slug, domain, or account handle")
    .option("--platform <platform>", "Filter to orgs with an account on this platform")
    .option("--json", "Output as JSON")
    .action(async (opts: { query?: string; platform?: string; json?: boolean }) => {
      const allOrgs = await listOrgs({ query: opts.query, platform: opts.platform });

      if (allOrgs.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("No organizations found."));
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(allOrgs, null, 2));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Name"),
          chalk.cyan("Slug"),
          chalk.cyan("Domain"),
          chalk.cyan("Updated"),
        ],
      });

      for (const o of allOrgs) {
        table.push([
          o.name,
          o.slug,
          o.domain ?? chalk.dim("—"),
          o.updatedAt,
        ]);
      }

      console.log(table.toString());
    });

  // ── org show ──
  org
    .command("show")
    .description("Show organization details")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      const accounts = await db
        .select()
        .from(orgAccounts)
        .where(eq(orgAccounts.orgId, found.id));
      const linkedSources = await getSourcesByOrg(found.id);

      if (opts.json) {
        console.log(JSON.stringify({ ...found, accounts, sources: linkedSources }, null, 2));
        return;
      }

      console.log(chalk.bold(found.name));
      console.log(`  Slug:    ${found.slug}`);
      console.log(`  Domain:  ${found.domain ?? chalk.dim("—")}`);
      console.log(`  Created: ${found.createdAt}`);
      console.log(`  Updated: ${found.updatedAt}`);

      if (accounts.length > 0) {
        console.log();
        console.log(chalk.bold("Accounts:"));
        for (const a of accounts) {
          console.log(`  ${chalk.cyan(a.platform)}  ${a.handle}`);
        }
      }

      if (linkedSources.length > 0) {
        console.log();
        console.log(chalk.bold("Sources:"));
        for (const s of linkedSources) {
          console.log(`  ${chalk.cyan(s.slug)}  ${s.name}  (${s.type})`);
        }
      }
    });

  // ── org remove ──
  org
    .command("remove")
    .description("Remove an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      await db.delete(organizations).where(eq(organizations.id, found.id));

      if (opts.json) {
        console.log(JSON.stringify({ removed: found.slug }, null, 2));
      } else {
        console.log(chalk.green(`Removed organization: ${found.name} (${found.slug})`));
      }
    });

  // ── org link ──
  org
    .command("link")
    .description("Link a platform account to an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .requiredOption("--platform <platform>", "Platform name (github, x, linkedin, etc.)")
    .requiredOption("--handle <handle>", "Account handle on the platform")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { platform: string; handle: string; json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      const [created] = await db.insert(orgAccounts).values({
        orgId: found.id,
        platform: opts.platform,
        handle: opts.handle,
      }).returning();

      await db
        .update(organizations)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, found.id));

      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(chalk.green(`Linked ${opts.platform}/${opts.handle} to ${found.name}`));
      }
    });

  // ── org unlink ──
  org
    .command("unlink")
    .description("Remove a platform account from an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .requiredOption("--platform <platform>", "Platform name")
    .requiredOption("--handle <handle>", "Account handle")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { platform: string; handle: string; json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        console.error(chalk.red(`Organization not found: ${identifier}`));
        process.exit(1);
      }

      const db = getDb();
      await db
        .delete(orgAccounts)
        .where(
          and(
            eq(orgAccounts.orgId, found.id),
            eq(orgAccounts.platform, opts.platform),
            eq(orgAccounts.handle, opts.handle),
          ),
        );

      await db
        .update(organizations)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(organizations.id, found.id));

      if (opts.json) {
        console.log(JSON.stringify({ unlinked: `${opts.platform}/${opts.handle}` }, null, 2));
      } else {
        console.log(chalk.green(`Unlinked ${opts.platform}/${opts.handle} from ${found.name}`));
      }
    });
}
