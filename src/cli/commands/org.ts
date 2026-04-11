import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  findOrg, getSourcesByOrg, listOrgs, createOrg, removeOrg,
  getOrgAccountsBySlug, linkOrgAccount, unlinkOrgAccount,
  getProductsByOrg, addTagsToOrg, removeTagsFromOrg, getTagsForOrg, updateOrg,
  listDomainAliases, addDomainAlias, removeDomainAlias,
  getKnowledgePageForOrg, getRecentReleases, upsertKnowledgePage,
} from "../../db/queries.js";
import { generateKnowledgePage } from "../../ai/knowledge.js";
import { DEFAULT_WINDOW_DAYS } from "../../ai/summarize.js";
import { daysAgoIso } from "../../lib/dates.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "../../lib/logger.js";
import { orgNotFound } from "../suggest.js";
import { toSlug } from "../../lib/slug.js";
import { isValidCategory, CATEGORIES } from "../../lib/categories.js";

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
    .option("--description <text>", "Brief product description (one sentence)")
    .option("--category <category>", "Category (e.g. ai, cloud, framework)")
    .option("--tags <tags>", "Comma-separated tags (e.g. typescript,react)")
    .option("--avatar <url>", "Set avatar image URL")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases org add "Acme Corp"
  releases org add "Acme Corp" --domain acme.com
  releases org add "Acme Corp" --description "Cloud deployment platform for frontend teams"
  releases org add "Acme Corp" --slug acme --json`)
    .action(async (name: string, opts: { domain?: string; slug?: string; description?: string; category?: string; tags?: string; avatar?: string; json?: boolean }) => {
      const slug = opts.slug ?? toSlug(name);

      const existing = await findOrg(slug);
      if (existing) {
        console.error(chalk.red(`Organization with slug "${slug}" already exists.`));
        process.exit(1);
      }

      if (opts.category && !isValidCategory(opts.category)) {
        console.error(chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`));
        process.exit(1);
      }

      const created = await createOrg(name, { slug, domain: opts.domain, description: opts.description, category: opts.category, avatarUrl: opts.avatar });

      if (opts.tags) {
        const tagList = opts.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
        if (tagList.length > 0) {
          await addTagsToOrg(created.id, tagList);
        }
      }

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
    .addHelpText("after", `
Examples:
  releases org list
  releases org list --query vercel
  releases org list --platform github --json

Note: org list shows a summary view (counts, last activity). Use "org show <slug>" to see
full details including linked accounts, tags, sources, and products.`)
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
    .option("--regenerate", "Regenerate the AI overview from recent releases")
    .addHelpText("after", `
Examples:
  releases org show acme
  releases org show acme.com
  releases org show acme --json
  releases org show acme --regenerate`)
    .action(async (identifier: string, opts: { json?: boolean; regenerate?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }

      const [accounts, orgProducts, linkedSources, orgTags, aliases, overview] = await Promise.all([
        getOrgAccountsBySlug(found.slug, found.id),
        getProductsByOrg(found.id),
        getSourcesByOrg(found.id),
        getTagsForOrg(found.id),
        listDomainAliases({ orgId: found.id }),
        getKnowledgePageForOrg(found.id, found.slug),
      ]);

      // Regenerate overview if requested
      if (opts.regenerate) {
        const windowDays = DEFAULT_WINDOW_DAYS;
        const cutoff = daysAgoIso(windowDays);
        const releaseArrays = await Promise.all(
          linkedSources.map((source) => getRecentReleases(source.id, cutoff, source.slug)),
        );
        const allReleases = releaseArrays.flat().sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
        if (allReleases.length === 0) {
          logger.warn(`No releases in the last ${windowDays} days for ${found.name} — cannot generate overview`);
        } else {
          logger.info(`Generating overview for ${found.name} (${allReleases.length} releases)...`);
          const result = await generateKnowledgePage({
            name: found.name,
            slug: found.slug,
            description: found.description || undefined,
            existingContent: overview?.content,
            newReleases: allReleases.slice(0, 50),
            totalReleaseCount: allReleases.length,
            sourceNames: linkedSources.map((s) => s.name),
          });
          if (result) {
            await upsertKnowledgePage({
              scope: "org",
              orgId: found.id,
              content: result.content,
              releaseCount: result.releaseCount,
              lastContributingReleaseAt: allReleases[0]?.publishedAt ?? null,
            });
            // Re-read so the display below shows the new content
            const updated = await getKnowledgePageForOrg(found.id, found.slug);
            if (updated) Object.assign(overview ?? {}, updated);
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ...found,
          accounts,
          products: orgProducts,
          sources: linkedSources,
          tags: orgTags,
          aliases: aliases.map((a) => a.domain),
          overview: overview?.content ?? null,
        }, null, 2));
        return;
      }

      console.log(chalk.bold(found.name));
      console.log(`  Slug:    ${found.slug}`);
      console.log(`  Domain:  ${found.domain ?? chalk.dim("—")}`);
      if (aliases.length > 0) console.log(`  Aliases: ${aliases.map((a) => a.domain).join(", ")}`);
      if (found.description) console.log(`  About:   ${found.description}`);
      console.log(`  Created: ${found.createdAt}`);
      console.log(`  Updated: ${found.updatedAt}`);
      if (found.category) console.log(`  Category: ${found.category}`);
      if (orgTags.length > 0) console.log(`  Tags:    ${orgTags.join(", ")}`);

      if (accounts.length > 0) {
        console.log();
        console.log(chalk.bold("Accounts:"));
        for (const a of accounts) {
          console.log(`  ${chalk.cyan(a.platform)}  ${a.handle}`);
        }
      }

      if (orgProducts.length > 0) {
        console.log();
        console.log(chalk.bold("Products:"));
        for (const p of orgProducts) {
          const urlLabel = p.url ? chalk.dim(` ${p.url}`) : "";
          console.log(`  ${chalk.cyan(p.slug)}  ${p.name}  (${p.sourceCount} sources)${urlLabel}`);
        }
      }

      if (linkedSources.length > 0) {
        console.log();
        console.log(chalk.bold("Sources:"));
        for (const s of linkedSources) {
          const statusLabel = s.isHidden
            ? "disabled"
            : s.consecutiveErrors && s.consecutiveErrors > 0
              ? "erroring"
              : "active";
          const statusColor = s.isHidden ? chalk.red : s.consecutiveErrors ? chalk.yellow : chalk.green;
          const status = statusColor(statusLabel.padEnd(16));
          const fetched = s.lastFetchedAt
            ? chalk.dim(s.lastFetchedAt.replace("T", " ").replace(/\.\d+Z$/, ""))
            : chalk.dim("never fetched");
          console.log(`  ${chalk.cyan(s.slug.padEnd(30))} ${status} ${fetched}`);
          console.log(`  ${" ".repeat(30)} ${chalk.dim(s.url)}`);
        }
      }

      if (overview?.content) {
        console.log();
        console.log(chalk.bold("Overview:"));
        console.log(stripAnsi(overview.content));
      }
    });

  // ── org edit ──
  org
    .command("edit")
    .description("Edit an organization")
    .argument("<identifier>", "Org slug, domain, or name")
    .option("--name <name>", "Update display name")
    .option("--slug <slug>", "Update slug")
    .option("--domain <domain>", "Update domain")
    .option("--description <text>", "Update description")
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
    .option("--avatar <url>", "Set avatar image URL")
    .option("--no-avatar", "Clear avatar URL")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { name?: string; slug?: string; domain?: string; description?: string; category?: string | boolean; avatar?: string | boolean; json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }

      const updates: Record<string, unknown> = {};
      if (opts.name !== undefined) updates.name = opts.name;
      if (opts.slug !== undefined) updates.slug = opts.slug;
      if (opts.domain !== undefined) updates.domain = opts.domain;
      if (opts.description !== undefined) updates.description = opts.description;

      if (opts.category === false) {
        updates.category = null;
      } else if (typeof opts.category === "string") {
        if (!isValidCategory(opts.category)) {
          console.error(chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`));
          process.exit(1);
        }
        updates.category = opts.category;
      }

      if (opts.avatar === false) {
        updates.avatarUrl = null;
      } else if (typeof opts.avatar === "string") {
        updates.avatarUrl = opts.avatar;
      }

      if (Object.keys(updates).length === 0) {
        console.error(chalk.yellow("No fields to update. Use --name, --slug, --domain, --description, --category, or --avatar."));
        process.exit(1);
      }

      const updated = await updateOrg(found, updates);

      if (opts.json) {
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(chalk.green(`Updated organization: ${updated.name} (${updated.slug})`));
      }
    });

  // ── org remove ──
  org
    .command("remove")
    .description("Remove an organization")
    .argument("<identifier>", "Org slug, domain, name, or account handle")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases org remove acme
  releases org remove acme --dry-run
  releases org remove acme --json`)
    .action(async (identifier: string, opts: { json?: boolean; dryRun?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }

      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ wouldRemove: found.slug, name: found.name }, null, 2));
        } else {
          console.log(chalk.yellow(`[dry-run] Would remove organization: ${found.name} (${found.slug})`));
        }
        return;
      }

      await removeOrg(found.id, found.slug);

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
    .addHelpText("after", `
Examples:
  releases org link acme --platform github --handle acme-corp
  releases org link acme --platform x --handle acmecorp --json`)
    .action(async (identifier: string, opts: { platform: string; handle: string; json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }

      const created = await linkOrgAccount(found.id, found.slug, opts.platform, opts.handle);

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
    .addHelpText("after", `
Examples:
  releases org unlink acme --platform github --handle acme-corp`)
    .action(async (identifier: string, opts: { platform: string; handle: string; json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }

      await unlinkOrgAccount(found.id, found.slug, opts.platform, opts.handle);

      if (opts.json) {
        console.log(JSON.stringify({ unlinked: `${opts.platform}/${opts.handle}` }, null, 2));
      } else {
        console.log(chalk.green(`Unlinked ${opts.platform}/${opts.handle} from ${found.name}`));
      }
    });

  // ── org tag ──
  const tag = org.command("tag").description("Manage organization tags");

  tag
    .command("add")
    .description("Add tags to an organization")
    .argument("<identifier>", "Org slug")
    .argument("<tags...>", "Tag names to add")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, tagNames: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }
      await addTagsToOrg(found.id, tagNames);
      if (opts.json) {
        const allTags = await getTagsForOrg(found.id);
        console.log(JSON.stringify({ tags: allTags }, null, 2));
      } else {
        console.log(chalk.green(`Added tags to ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("remove")
    .description("Remove tags from an organization")
    .argument("<identifier>", "Org slug")
    .argument("<tags...>", "Tag names to remove")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, tagNames: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }
      await removeTagsFromOrg(found.id, tagNames);
      if (opts.json) {
        const allTags = await getTagsForOrg(found.id);
        console.log(JSON.stringify({ tags: allTags }, null, 2));
      } else {
        console.log(chalk.green(`Removed tags from ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("list")
    .description("List tags for an organization")
    .argument("<identifier>", "Org slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) {
        return orgNotFound(identifier);
      }
      const allTags = await getTagsForOrg(found.id);
      if (opts.json) {
        console.log(JSON.stringify(allTags, null, 2));
      } else if (allTags.length === 0) {
        console.log(chalk.yellow(`No tags for ${found.name}`));
      } else {
        console.log(allTags.join(", "));
      }
    });

  // ── org alias ──
  const alias = org.command("alias").description("Manage domain aliases for an organization");

  alias
    .command("add")
    .description("Add domain aliases to an organization")
    .argument("<identifier>", "Org slug")
    .argument("<domains...>", "Domain names to add (e.g. claude.ai claude.com)")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const results = [];
      for (const domain of domains) {
        try {
          const created = await addDomainAlias(domain, { orgId: found.id });
          results.push(created);
        } catch (err) {
          console.error(chalk.red(`Failed to add alias "${domain}": ${err instanceof Error ? err.message : err}`));
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const r of results) {
          console.log(chalk.green(`Added alias: ${r.domain} → ${found.name}`));
        }
      }
    });

  alias
    .command("remove")
    .description("Remove domain aliases from an organization")
    .argument("<identifier>", "Org slug")
    .argument("<domains...>", "Domain names to remove")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const removed = [];
      for (const domain of domains) {
        const ok = await removeDomainAlias(domain, { orgId: found.id });
        if (ok) {
          removed.push(domain);
        } else {
          console.error(chalk.yellow(`Alias "${domain}" not found.`));
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ removed }, null, 2));
      } else {
        for (const d of removed) {
          console.log(chalk.green(`Removed alias: ${d}`));
        }
      }
    });

  alias
    .command("list")
    .description("List domain aliases for an organization")
    .argument("<identifier>", "Org slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const aliases = await listDomainAliases({ orgId: found.id });

      if (opts.json) {
        console.log(JSON.stringify(aliases.map((a) => a.domain), null, 2));
      } else if (aliases.length === 0) {
        console.log(chalk.yellow(`No domain aliases for ${found.name}`));
      } else {
        for (const a of aliases) {
          console.log(a.domain);
        }
      }
    });
}
