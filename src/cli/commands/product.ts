import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import {
  findOrg, findProduct, getProductsByOrg, createProduct, updateProduct,
  deleteProduct, getSourcesByOrg, updateSource, removeOrg,
  getOrgAccountsBySlug, linkOrgAccount,
  addTagsToProduct, removeTagsFromProduct, getTagsForProduct,
  listDomainAliases, addDomainAlias, removeDomainAlias,
} from "../../db/queries.js";
import { toSlug } from "@releases/core/slug";
import { isValidCategory, CATEGORIES } from "@releases/core/categories";

export function registerProductCommand(program: Command) {
  const product = program
    .command("product")
    .description("Manage products");

  // ── product list ──
  product
    .command("list")
    .description("List products for an organization")
    .argument("[org-slug]", "Organization slug")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin product list acme
  releases admin product list acme --json`)
    .action(async (orgSlug: string | undefined, opts: { json?: boolean }) => {
      if (!orgSlug) {
        console.error(chalk.red("Please specify an org slug: releases admin product list <org-slug>"));
        process.exit(1);
      }

      const org = await findOrg(orgSlug);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${orgSlug}`));
        process.exit(1);
      }

      const productList = await getProductsByOrg(org.id);

      if (productList.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow(`No products found for organization: ${org.name}`));
        }
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(productList, null, 2));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Name"),
          chalk.cyan("Slug"),
          chalk.cyan("URL"),
          chalk.cyan("Sources"),
        ],
      });

      for (const p of productList) {
        table.push([
          p.name,
          p.slug,
          p.url ?? chalk.dim("—"),
          String(p.sourceCount),
        ]);
      }

      console.log(table.toString());
    });

  // ── product add ──
  product
    .command("add")
    .description("Create a new product under an organization")
    .argument("<name>", "Product name")
    .requiredOption("--org <org-slug>", "Organization slug")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--url <url>", "Product URL")
    .option("--description <text>", "Brief product description")
    .option("--category <category>", "Category (e.g. ai, framework, developer-tools)")
    .option("--tags <tags>", "Comma-separated tags (e.g. react,ssr)")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin product add "Acme CLI" --org acme
  releases admin product add "Acme CLI" --org acme --slug acme-cli --url https://acme.com/cli
  releases admin product add "Acme CLI" --org acme --description "Command-line tool for Acme" --json`)
    .action(async (name: string, opts: { org: string; slug?: string; url?: string; description?: string; category?: string; tags?: string; json?: boolean }) => {
      const org = await findOrg(opts.org);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${opts.org}`));
        process.exit(1);
      }

      const slug = opts.slug ?? toSlug(name);

      if (opts.category && !isValidCategory(opts.category)) {
        console.error(chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`));
        process.exit(1);
      }

      let created;
      try {
        created = await createProduct(org.id, name, {
          slug,
          url: opts.url,
          description: opts.description,
          category: opts.category,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists") || msg.includes("UNIQUE constraint") || msg.includes("conflict")) {
          console.error(chalk.red(`Product with slug "${slug}" already exists.`));
        } else {
          console.error(chalk.red(`Failed to create product: ${msg}`));
        }
        process.exit(1);
      }

      if (opts.tags) {
        const tagList = opts.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
        if (tagList.length > 0) {
          await addTagsToProduct(created.id, tagList);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(chalk.green(`Product added: ${name} (${slug}) under ${org.name}`));
      }
    });

  // ── product edit ──
  product
    .command("edit")
    .description("Update a product")
    .argument("<slug>", "Product slug")
    .option("--name <name>", "New product name")
    .option("--url <url>", "New product URL")
    .option("--description <text>", "New product description")
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin product edit acme-cli --name "Acme CLI v2"
  releases admin product edit acme-cli --url https://acme.com/cli --json`)
    .action(async (slug: string, opts: { name?: string; url?: string; description?: string; category?: string | boolean; json?: boolean }) => {
      const found = await findProduct(slug);
      if (!found) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }

      const updates: Record<string, unknown> = {};
      if (opts.name !== undefined) updates.name = opts.name;
      if (opts.url !== undefined) updates.url = opts.url;
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

      if (Object.keys(updates).length === 0) {
        console.error(chalk.yellow("No fields to update. Use --name, --url, --description, or --category."));
        process.exit(1);
      }

      const updated = await updateProduct(found, updates);

      if (opts.json) {
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(chalk.green(`Product updated: ${updated.name} (${updated.slug})`));
      }
    });

  // ── product remove ──
  product
    .command("remove")
    .description("Delete a product (sources will have their product association cleared)")
    .argument("<slug>", "Product slug")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin product remove acme-cli
  releases admin product remove acme-cli --dry-run
  releases admin product remove acme-cli --json`)
    .action(async (slug: string, opts: { dryRun?: boolean; json?: boolean }) => {
      const found = await findProduct(slug);
      if (!found) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }

      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ wouldRemove: found.slug, name: found.name }, null, 2));
        } else {
          console.log(chalk.yellow(`[dry-run] Would remove product: ${found.name} (${found.slug})`));
        }
        return;
      }

      await deleteProduct(found.id);

      if (opts.json) {
        console.log(JSON.stringify({ removed: found.slug }, null, 2));
      } else {
        console.log(chalk.green(`Removed product: ${found.name} (${found.slug})`));
      }
    });

  // ── product adopt ──
  product
    .command("adopt")
    .description("Convert an organization into a product under another organization")
    .argument("<source-org-slug>", "Org to convert into a product")
    .requiredOption("--into <target-org-slug>", "Target org that will own the new product")
    .option("--slug <slug>", "Custom slug for the new product (defaults to source org slug)")
    .option("--url <url>", "URL for the new product (defaults to source org domain)")
    .option("--dry-run", "Show what would happen without making changes")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin product adopt acme-cli --into acme
  releases admin product adopt acme-cli --into acme --slug cli --dry-run
  releases admin product adopt acme-cli --into acme --url https://acme.com/cli --json`)
    .action(async (sourceOrgSlug: string, opts: { into: string; slug?: string; url?: string; dryRun?: boolean; json?: boolean }) => {
      const sourceOrg = await findOrg(sourceOrgSlug);
      if (!sourceOrg) {
        console.error(chalk.red(`Source organization not found: ${sourceOrgSlug}`));
        process.exit(1);
      }

      const targetOrg = await findOrg(opts.into);
      if (!targetOrg) {
        console.error(chalk.red(`Target organization not found: ${opts.into}`));
        process.exit(1);
      }

      if (sourceOrg.id === targetOrg.id) {
        console.error(chalk.red("Source and target organizations must be different."));
        process.exit(1);
      }

      const sources = await getSourcesByOrg(sourceOrg.id);
      const productSlug = opts.slug ?? sourceOrg.slug;
      const productUrl = opts.url ?? (sourceOrg.domain ? `https://${sourceOrg.domain}` : undefined);

      if (opts.dryRun) {
        const plan = {
          action: "adopt",
          sourceOrg: { slug: sourceOrg.slug, name: sourceOrg.name },
          targetOrg: { slug: targetOrg.slug, name: targetOrg.name },
          newProduct: { slug: productSlug, name: sourceOrg.name, url: productUrl ?? null },
          sourcesToMove: sources.map((s) => s.slug),
          wouldRemoveOrg: sourceOrg.slug,
        };

        if (opts.json) {
          console.log(JSON.stringify(plan, null, 2));
        } else {
          console.log(chalk.yellow(`[dry-run] Would adopt "${sourceOrg.name}" as product under "${targetOrg.name}"`));
          console.log(`  New product slug: ${productSlug}`);
          if (productUrl) console.log(`  New product URL:  ${productUrl}`);
          console.log(`  Sources to move:  ${sources.length > 0 ? sources.map((s) => s.slug).join(", ") : chalk.dim("none")}`);
          console.log(`  Would remove org: ${sourceOrg.slug}`);
        }
        return;
      }

      // Create the product under the target org
      const created = await createProduct(targetOrg.id, sourceOrg.name, {
        slug: productSlug,
        url: productUrl,
        description: sourceOrg.description ?? undefined,
      });

      // Move sources to target org and assign to the new product
      for (const source of sources) {
        await updateSource(source, { orgId: targetOrg.id, productId: created.id });
      }

      // Move org accounts to target org (skip duplicates)
      const accounts = await getOrgAccountsBySlug(sourceOrg.slug, sourceOrg.id);
      for (const acct of accounts) {
        try {
          await linkOrgAccount(targetOrg.id, targetOrg.slug, acct.platform, acct.handle);
        } catch {
          // Skip duplicates — account already exists on target org
        }
      }

      // Remove the source org
      await removeOrg(sourceOrg.id, sourceOrg.slug);

      if (opts.json) {
        console.log(JSON.stringify({
          adopted: sourceOrg.slug,
          into: targetOrg.slug,
          product: created,
          sourcesMoved: sources.length,
        }, null, 2));
      } else {
        console.log(chalk.green(`Adopted "${sourceOrg.name}" as product under "${targetOrg.name}" (${productSlug})`));
        if (sources.length > 0) {
          console.log(`  Moved ${sources.length} source(s) to ${targetOrg.name}`);
        }
      }
    });

  // ── product tag ──
  const tag = product.command("tag").description("Manage product tags");

  tag
    .command("add")
    .description("Add tags to a product")
    .argument("<slug>", "Product slug")
    .argument("<tags...>", "Tag names to add")
    .option("--json", "Output as JSON")
    .action(async (slug: string, tagNames: string[], opts: { json?: boolean }) => {
      const found = await findProduct(slug);
      if (!found) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }
      await addTagsToProduct(found.id, tagNames);
      if (opts.json) {
        const allTags = await getTagsForProduct(found.id);
        console.log(JSON.stringify({ tags: allTags }, null, 2));
      } else {
        console.log(chalk.green(`Added tags to ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("remove")
    .description("Remove tags from a product")
    .argument("<slug>", "Product slug")
    .argument("<tags...>", "Tag names to remove")
    .option("--json", "Output as JSON")
    .action(async (slug: string, tagNames: string[], opts: { json?: boolean }) => {
      const found = await findProduct(slug);
      if (!found) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }
      await removeTagsFromProduct(found.id, tagNames);
      if (opts.json) {
        const allTags = await getTagsForProduct(found.id);
        console.log(JSON.stringify({ tags: allTags }, null, 2));
      } else {
        console.log(chalk.green(`Removed tags from ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("list")
    .description("List tags for a product")
    .argument("<slug>", "Product slug")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      const found = await findProduct(slug);
      if (!found) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }
      const allTags = await getTagsForProduct(found.id);
      if (opts.json) {
        console.log(JSON.stringify(allTags, null, 2));
      } else if (allTags.length === 0) {
        console.log(chalk.yellow(`No tags for ${found.name}`));
      } else {
        console.log(allTags.join(", "));
      }
    });

  // ── product alias ──
  const alias = product.command("alias").description("Manage domain aliases for a product");

  alias
    .command("add")
    .description("Add domain aliases to a product")
    .argument("<identifier>", "Product slug")
    .argument("<domains...>", "Domain names to add")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findProduct(identifier);
      if (!found) {
        console.error(chalk.red(`Product not found: ${identifier}`));
        process.exit(1);
      }

      const results = [];
      for (const domain of domains) {
        try {
          const created = await addDomainAlias(domain, { productId: found.id });
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
    .description("Remove domain aliases from a product")
    .argument("<identifier>", "Product slug")
    .argument("<domains...>", "Domain names to remove")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findProduct(identifier);
      if (!found) {
        console.error(chalk.red(`Product not found: ${identifier}`));
        process.exit(1);
      }

      const removed = [];
      for (const domain of domains) {
        const ok = await removeDomainAlias(domain, { productId: found.id });
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
    .description("List domain aliases for a product")
    .argument("<identifier>", "Product slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findProduct(identifier);
      if (!found) {
        console.error(chalk.red(`Product not found: ${identifier}`));
        process.exit(1);
      }

      const aliases = await listDomainAliases({ productId: found.id });

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
