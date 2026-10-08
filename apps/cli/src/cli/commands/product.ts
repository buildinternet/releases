import { Command } from "commander";
import chalk from "chalk";
import { renderTable, type ColumnSpec } from "../render/table.js";
import {
  findOrg,
  listOrgs,
  getSourcesByOrg,
  removeOrg,
  getOrgAccountsBySlug,
  linkOrgAccount,
} from "../../api/orgs.js";
import {
  findProduct,
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  addTagsToProduct,
  removeTagsFromProduct,
  getTagsForProduct,
} from "../../api/products.js";
import { updateSource, getAliases, setAliases } from "../../api/sources.js";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isValidCategory, CATEGORIES } from "@buildinternet/releases-core/categories";
import { isValidKind, KIND_VALUES, type Kind } from "@buildinternet/releases-core/kinds";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { handlePageAll } from "../../lib/paginate.js";
import {
  computePagination,
  DEFAULT_PAGE_SIZE,
  formatTruncationWarning,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { parseTagList } from "../../lib/flags.js";
import { buildNoticePatch, type EntityWithNotice } from "../../lib/notice.js";

/**
 * Move every source in `sources` to `targetOrg.id` + `productId`, copy
 * `sourceOrg`'s org_accounts onto the target (skipping duplicates), then
 * soft-delete the now-empty source org. Mirrors the server-side
 * `migrateOrgToProduct` helper but goes through the public REST endpoints.
 */
async function migrateOrgToProduct(args: {
  sourceOrg: { slug: string; id: string };
  targetOrg: { slug: string; id: string };
  productId: string;
  sources: { id: string }[];
}): Promise<void> {
  const { sourceOrg, targetOrg, productId, sources } = args;
  await Promise.all(
    sources.map((source) => updateSource(source, { orgId: targetOrg.id, productId })),
  );

  const accounts = await getOrgAccountsBySlug(sourceOrg.slug);
  await Promise.all(
    accounts.map(async (acct) => {
      try {
        await linkOrgAccount(targetOrg.slug, acct.platform, acct.handle);
      } catch (err) {
        // Per-handle uniqueness comes from `idx_org_accounts_platform_handle` —
        // a 409 here means the target already has that account linked, which
        // is the intended no-op. Anything else (404 target org gone, 5xx, …)
        // must propagate so we don't silently strand half a migration.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("(409)")) throw err;
      }
    }),
  );

  await removeOrg(sourceOrg.slug);
}

// ── Shared action handlers ────────────────────────────────────────────────────

type ProductCreateOpts = {
  org: string;
  slug?: string;
  url?: string;
  description?: string;
  category?: string;
  kind?: string;
  tags?: string;
  json?: boolean;
  dryRun?: boolean;
};

async function productCreateAction(name: string, opts: ProductCreateOpts): Promise<void> {
  const org = await findOrg(opts.org);
  if (!org) {
    console.error(chalk.red(`Organization not found: ${opts.org}`));
    process.exit(1);
  }

  const slug = opts.slug ?? toSlug(name);

  if (opts.category && !isValidCategory(opts.category)) {
    console.error(
      chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`),
    );
    process.exit(1);
  }

  if (opts.kind !== undefined && !isValidKind(opts.kind)) {
    logger.error(`Invalid kind "${opts.kind}". Must be one of: ${KIND_VALUES.join(", ")}`);
    process.exit(1);
  }
  const kind = opts.kind as Kind | undefined;

  if (opts.dryRun) {
    const tagList = parseTagList(opts.tags);
    const plan = {
      wouldCreate: true,
      name,
      slug,
      org: { id: org.id, slug: org.slug, name: org.name },
      url: opts.url ?? null,
      description: opts.description ?? null,
      category: opts.category ?? null,
      kind: kind ?? null,
      tagsToAdd: tagList,
    };
    if (opts.json) await writeJson(markDryRun(plan));
    else
      console.log(
        chalk.yellow(
          `[dry-run] Would create product: ${name} (${slug}) under ${org.name}${tagList.length ? ` with tags: ${tagList.join(", ")}` : ""}`,
        ),
      );
    return;
  }

  let created;
  try {
    created = await createProduct(org.id, name, {
      slug,
      url: opts.url,
      description: opts.description,
      category: opts.category,
      kind,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("already exists") ||
      msg.includes("UNIQUE constraint") ||
      msg.includes("conflict")
    ) {
      console.error(chalk.red(`Product with slug "${slug}" already exists.`));
    } else {
      console.error(chalk.red(`Failed to create product: ${msg}`));
    }
    process.exit(1);
  }

  if (opts.tags) {
    const tagList = opts.tags
      .split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    if (tagList.length > 0) await addTagsToProduct(created.id, tagList);
  }

  if (opts.json) await writeJson(created);
  else console.log(chalk.green(`Product created: ${name} (${slug}) under ${org.name}`));
}

type ProductUpdateOpts = {
  name?: string;
  url?: string;
  description?: string;
  category?: string | boolean;
  kind?: string | boolean;
  notice?: string;
  noticeLink?: string;
  noticeLinkText?: string;
  clearNotice?: boolean;
  json?: boolean;
  dryRun?: boolean;
};

async function productUpdateAction(slug: string, opts: ProductUpdateOpts): Promise<void> {
  const found = (await findProduct(slug)) as EntityWithNotice<
    Awaited<ReturnType<typeof findProduct>>
  >;
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
      console.error(
        chalk.red(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`),
      );
      process.exit(1);
    }
    updates.category = opts.category;
  }

  if (opts.kind === false) {
    updates.kind = null;
  } else if (typeof opts.kind === "string") {
    if (!isValidKind(opts.kind)) {
      logger.error(`Invalid kind "${opts.kind}". Must be one of: ${KIND_VALUES.join(", ")}`);
      process.exit(1);
    }
    updates.kind = opts.kind satisfies Kind;
  }

  const noticePatch = buildNoticePatch(opts, logger);
  if (noticePatch !== null) updates.notice = noticePatch.notice;

  if (Object.keys(updates).length === 0) {
    console.error(chalk.yellow("No fields to update."));
    process.exit(1);
  }

  if (opts.dryRun) {
    if (opts.json)
      await writeJson(markDryRun({ wouldUpdate: found.slug, name: found.name, updates }));
    else {
      console.log(chalk.yellow(`[dry-run] Would update product: ${found.name} (${found.slug})`));
      for (const [k, v] of Object.entries(updates))
        console.log(`  ${k} → ${v === null ? "(cleared)" : String(v)}`);
    }
    return;
  }

  const updated = await updateProduct(found, updates);

  if (opts.json) await writeJson(updated);
  else console.log(chalk.green(`Product updated: ${updated.name} (${updated.slug})`));
}

type ProductDeleteOpts = { dryRun?: boolean; json?: boolean };

async function productDeleteAction(slug: string, opts: ProductDeleteOpts): Promise<void> {
  const found = await findProduct(slug);
  if (!found) {
    console.error(chalk.red(`Product not found: ${slug}`));
    process.exit(1);
  }

  if (opts.dryRun) {
    if (opts.json) await writeJson(markDryRun({ wouldRemove: found.slug, name: found.name }));
    else console.log(chalk.yellow(`[dry-run] Would delete product: ${found.name} (${found.slug})`));
    return;
  }

  await deleteProduct(found.id);

  if (opts.json) await writeJson({ removed: found.slug });
  else console.log(chalk.green(`Deleted product: ${found.name} (${found.slug})`));
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerProductCommand(program: Command) {
  const product = program.command("product").description("Manage products");

  product
    .command("list")
    .description("List products for an organization, or across all orgs when no org is given")
    .argument(
      "[org]",
      "Organization (org_…, slug, domain, name, or handle). Omit to list products across every org.",
    )
    .option("--json", "Output as JSON")
    .option(
      "--kind <kind>",
      `Filter by product taxonomy (${KIND_VALUES.join(", ")}). Matches the product's own kind only.`,
    )
    .option("--limit <n>", `Limit the number of results (default ${DEFAULT_PAGE_SIZE})`)
    .option("--page <n>", "Page number for paginated results")
    .option(
      "--page-all",
      "Stream every page as newline-delimited JSON (one product per line, --json only)",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases admin product list vercel          Products under one org
  releases admin product list --kind sdk      Every SDK product across all orgs
  releases admin product list --json          All products as JSON (for audits)
  releases admin product list --json --page-all   Stream every product as NDJSON`,
    )
    .action(
      async (
        orgIdentifier: string | undefined,
        opts: { json?: boolean; kind?: string; limit?: string; page?: string; pageAll?: boolean },
      ) => {
        if (opts.kind !== undefined && !isValidKind(opts.kind)) {
          logger.error(`Invalid kind "${opts.kind}". Must be one of: ${KIND_VALUES.join(", ")}`);
          process.exit(1);
        }
        const kind = opts.kind as Kind | undefined;

        const parsedLimit = opts.limit === undefined ? undefined : Number(opts.limit);
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
          logger.error("--limit must be a positive integer");
          process.exit(1);
        }
        const explicitLimit = parsedLimit !== undefined;
        const pageSize = explicitLimit ? parsedLimit : DEFAULT_PAGE_SIZE;

        const parsedPage = opts.page === undefined ? 1 : Number(opts.page);
        if (!Number.isInteger(parsedPage) || parsedPage <= 0) {
          logger.error("--page must be a positive integer");
          process.exit(1);
        }
        const page = parsedPage;

        // org omitted → enumerate products across every org (releases-cli#259).
        let org: Awaited<ReturnType<typeof findOrg>> | undefined;
        if (orgIdentifier) {
          org = await findOrg(orgIdentifier);
          if (!org) {
            console.error(chalk.red(`Organization not found: ${orgIdentifier}`));
            process.exit(1);
          }
        }

        // --page-all: stream every page as NDJSON (one product per line). Returns
        // true only when it handled the request (--json); otherwise falls through.
        if (
          await handlePageAll(opts, async (p) => {
            const { items, pagination } = await listProducts({
              orgId: org?.id,
              kind,
              limit: pageSize,
              page: p,
            });
            return { items, hasMore: pagination.hasMore };
          })
        )
          return;

        const { items: productList, pagination } = await listProducts({
          orgId: org?.id,
          kind,
          limit: explicitLimit ? pageSize : undefined,
          page: page > 1 ? page : undefined,
        });

        if (productList.length === 0) {
          if (opts.json) await writeJson([]);
          else if (org)
            console.log(chalk.yellow(`No products found for organization: ${org.name}`));
          else console.log(chalk.yellow("No products found."));
          return;
        }

        const warnIfTruncated = () => {
          if (!explicitLimit && pagination.hasMore) {
            logger.warn(
              formatTruncationWarning({
                returned: productList.length,
                pageSize,
                commandExample: "releases admin product list --limit <n> --page <p>",
              }),
            );
          }
        };

        if (opts.json) {
          await writeJson(productList);
          warnIfTruncated();
          return;
        }

        // Cross-org listing needs an Org column so a bare product slug is
        // attributable; resolve ids → names once (orgs with products but no
        // releases included). Org-scoped listing keeps the original columns.
        const crossOrg = !org;
        const orgNameById = new Map<string, string>();
        if (crossOrg) {
          const orgs = await listOrgs({ limit: 500, includeEmpty: true });
          for (const o of orgs.items) orgNameById.set(o.id, o.name);
        }

        const head: ColumnSpec[] = [{ label: "Name" }];
        if (crossOrg) head.push({ label: "Org" });
        head.push(
          { label: "Slug", noTruncate: true },
          { label: "URL" },
          { label: "Avatar" },
          { label: "Sources", noTruncate: true, alignRight: true },
        );

        console.log(
          renderTable({
            head,
            rows: productList.map((p) => {
              const row = [p.name];
              if (crossOrg) row.push(orgNameById.get(p.orgId) ?? p.orgId);
              row.push(
                p.slug,
                p.url ?? chalk.dim("—"),
                p.avatarUrl ?? chalk.dim("—"),
                String(p.sourceCount),
              );
              return row;
            }),
          }),
        );

        warnIfTruncated();
      },
    );

  // ── product create (canonical) / product add (deprecated) ──
  product
    .command("create")
    .description("Create a new product under an organization")
    .argument("<name>", "Product name")
    .requiredOption("--org <org>", "Organization (org_…, slug, domain, name, or handle)")
    .option("--slug <slug>", "Custom slug")
    .option("--url <url>", "Product URL")
    .option("--description <text>", "Brief product description")
    .option("--category <category>", "Category")
    .option(
      "--kind <kind>",
      `Product taxonomy (${KIND_VALUES.join(", ")}). Sources without their own kind inherit this on content surfaces.`,
    )
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be created without writing")
    .addHelpText(
      "after",
      `
Examples:
  releases admin product create "Next.js" --org vercel --kind sdk
  releases admin product create "CLI" --org acme --category developer-tools
  releases admin product create "Mobile SDK" --org stripe --kind mobile --dry-run`,
    )
    .action(productCreateAction);

  product
    .command("add")
    .description("(deprecated — use create) Create a new product under an organization")
    .argument("<name>", "Product name")
    .requiredOption("--org <org>", "Organization (org_…, slug, domain, name, or handle)")
    .option("--slug <slug>", "Custom slug")
    .option("--url <url>", "Product URL")
    .option("--description <text>", "Brief product description")
    .option("--category <category>", "Category")
    .option(
      "--kind <kind>",
      `Product taxonomy (${KIND_VALUES.join(", ")}). Sources without their own kind inherit this on content surfaces.`,
    )
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be created without writing")
    .action(warnDeprecatedAlias<[string, ProductCreateOpts]>("add", "create", productCreateAction));

  // ── product update (canonical) / product edit (deprecated) ──
  product
    .command("update")
    .description("Update a product")
    .argument("<product>", "Product ID (prod_…) or slug")
    .option("--name <name>", "New product name")
    .option("--url <url>", "New product URL")
    .option("--description <text>", "New product description")
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
    .option("--kind <kind>", `Set product taxonomy (${KIND_VALUES.join(", ")})`)
    .option("--no-kind", "Clear product kind")
    .option("--notice <message>", "Set a curator notice on this product (max 280 chars)")
    .option(
      "--notice-link <coordinate|url>",
      "Optional pointer: registry coordinate (org/slug) or https:// URL",
    )
    .option(
      "--notice-link-text <label>",
      "Optional link label for the notice pointer (max 60 chars)",
    )
    .option("--clear-notice", "Remove the notice from this product")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing")
    .addHelpText(
      "after",
      `
Examples:
  releases admin product update next-js --kind sdk
  releases admin product update prod_abc123 --name "Next.js" --category developer-tools
  releases admin product update next-js --no-kind
  releases admin product update windsurf --notice "Windsurf is now Cognition's Devin" --notice-link cognition/devin
  releases admin product update windsurf --clear-notice`,
    )
    .action(productUpdateAction);

  product
    .command("edit")
    .description("(deprecated — use update) Update a product")
    .argument("<product>", "Product ID (prod_…) or slug")
    .option("--name <name>", "New product name")
    .option("--url <url>", "New product URL")
    .option("--description <text>", "New product description")
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
    .option("--kind <kind>", `Set product taxonomy (${KIND_VALUES.join(", ")})`)
    .option("--no-kind", "Clear product kind")
    .option("--notice <message>", "Set a curator notice on this product (max 280 chars)")
    .option(
      "--notice-link <coordinate|url>",
      "Optional pointer: registry coordinate (org/slug) or https:// URL",
    )
    .option(
      "--notice-link-text <label>",
      "Optional link label for the notice pointer (max 60 chars)",
    )
    .option("--clear-notice", "Remove the notice from this product")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing")
    .action(
      warnDeprecatedAlias<[string, ProductUpdateOpts]>("edit", "update", productUpdateAction),
    );

  // ── product delete (canonical) / product remove (deprecated) ──
  product
    .command("delete")
    .description("Delete a product")
    .argument("<product>", "Product ID (prod_…) or slug")
    .option("--dry-run", "Show what would be deleted without deleting")
    .option("--json", "Output as JSON")
    .action(productDeleteAction);

  product
    .command("remove")
    .description("(deprecated — use delete) Delete a product")
    .argument("<product>", "Product ID (prod_…) or slug")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--json", "Output as JSON")
    .action(
      warnDeprecatedAlias<[string, ProductDeleteOpts]>("remove", "delete", productDeleteAction),
    );

  product
    .command("adopt")
    .description("Convert an organization into a product under another organization")
    .argument(
      "<source-org>",
      "Org to convert into a product (org_…, slug, domain, name, or handle)",
    )
    .requiredOption(
      "--into <target-org>",
      "Target org that will own the new product (org_…, slug, domain, name, or handle)",
    )
    .option("--slug <slug>", "Custom slug for the new product")
    .option("--url <url>", "URL for the new product")
    .option(
      "--merge-into <product>",
      "Fold source org into an existing product (slug or prod_… ID) under --into instead of creating a new one",
    )
    .option("--dry-run", "Show what would happen")
    .option("--json", "Output as JSON")
    .action(
      async (
        sourceOrgSlug: string,
        opts: {
          into: string;
          slug?: string;
          url?: string;
          mergeInto?: string;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        if (opts.mergeInto && (opts.slug || opts.url)) {
          console.error(
            chalk.red(
              "--merge-into cannot be combined with --slug or --url (existing product is reused).",
            ),
          );
          process.exit(1);
        }

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

        if (opts.mergeInto) {
          const existingProduct = await findProduct(opts.mergeInto);
          if (!existingProduct) {
            console.error(chalk.red(`Product not found: ${opts.mergeInto}`));
            process.exit(1);
          }
          if (existingProduct.orgId !== targetOrg.id) {
            console.error(
              chalk.red(
                `Product "${existingProduct.slug}" is not under target org "${targetOrg.slug}".`,
              ),
            );
            process.exit(1);
          }

          if (opts.dryRun) {
            const plan = {
              action: "adopt",
              mergeInto: existingProduct.slug,
              sourceOrg: { slug: sourceOrg.slug, name: sourceOrg.name },
              targetOrg: { slug: targetOrg.slug, name: targetOrg.name },
              existingProduct: { slug: existingProduct.slug, name: existingProduct.name },
              sourcesToMove: sources.map((s) => s.slug),
              wouldRemoveOrg: sourceOrg.slug,
            };

            if (opts.json) {
              await writeJson(markDryRun(plan));
            } else {
              console.log(
                chalk.yellow(
                  `[dry-run] Would fold "${sourceOrg.name}" into existing product "${existingProduct.slug}" under "${targetOrg.name}"`,
                ),
              );
              console.log(
                `  Sources to move:  ${sources.length > 0 ? sources.map((s) => s.slug).join(", ") : chalk.dim("none")}`,
              );
              console.log(`  Would remove org: ${sourceOrg.slug}`);
            }
            return;
          }

          await migrateOrgToProduct({
            sourceOrg,
            targetOrg,
            productId: existingProduct.id,
            sources,
          });

          if (opts.json) {
            await writeJson({
              adopted: sourceOrg.slug,
              into: targetOrg.slug,
              mergedInto: existingProduct.slug,
              product: existingProduct,
              sourcesMoved: sources.length,
            });
          } else {
            console.log(
              chalk.green(
                `Folded "${sourceOrg.name}" into existing product "${existingProduct.slug}" under "${targetOrg.name}"`,
              ),
            );
            if (sources.length > 0)
              console.log(`  Moved ${sources.length} source(s) to ${targetOrg.name}`);
          }
          return;
        }

        const productSlug = opts.slug ?? sourceOrg.slug;
        const productUrl =
          opts.url ?? (sourceOrg.domain ? `https://${sourceOrg.domain}` : undefined);

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
            await writeJson(markDryRun(plan));
          } else {
            console.log(
              chalk.yellow(
                `[dry-run] Would adopt "${sourceOrg.name}" as product under "${targetOrg.name}"`,
              ),
            );
            console.log(`  New product slug: ${productSlug}`);
            if (productUrl) console.log(`  New product URL:  ${productUrl}`);
            console.log(
              `  Sources to move:  ${sources.length > 0 ? sources.map((s) => s.slug).join(", ") : chalk.dim("none")}`,
            );
            console.log(`  Would remove org: ${sourceOrg.slug}`);
          }
          return;
        }

        const created = await createProduct(targetOrg.id, sourceOrg.name, {
          slug: productSlug,
          url: productUrl,
          description: sourceOrg.description ?? undefined,
        });

        await migrateOrgToProduct({
          sourceOrg,
          targetOrg,
          productId: created.id,
          sources,
        });

        if (opts.json) {
          await writeJson({
            adopted: sourceOrg.slug,
            into: targetOrg.slug,
            product: created,
            sourcesMoved: sources.length,
          });
        } else {
          console.log(
            chalk.green(
              `Adopted "${sourceOrg.name}" as product under "${targetOrg.name}" (${productSlug})`,
            ),
          );
          if (sources.length > 0)
            console.log(`  Moved ${sources.length} source(s) to ${targetOrg.name}`);
        }
      },
    );

  // ── product tag — membership verbs (add/remove) stay unchanged ──
  const tag = product.command("tag").description("Manage product tags");

  tag
    .command("add")
    .description("Add tags to a product")
    .argument("<product>", "Product ID (prod_…) or slug")
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
        await writeJson({ tags: allTags });
      } else {
        console.log(chalk.green(`Added tags to ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("remove")
    .description("Remove tags from a product")
    .argument("<product>", "Product ID (prod_…) or slug")
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
        await writeJson({ tags: allTags });
      } else {
        console.log(chalk.green(`Removed tags from ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("list")
    .description("List tags for a product")
    .argument("<product>", "Product ID (prod_…) or slug")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      const found = await findProduct(slug);
      if (!found) {
        console.error(chalk.red(`Product not found: ${slug}`));
        process.exit(1);
      }
      const allTags = await getTagsForProduct(found.id);
      if (opts.json) await writeJson(allTags);
      else if (allTags.length === 0) console.log(chalk.yellow(`No tags for ${found.name}`));
      else console.log(allTags.join(", "));
    });

  // ── product alias — membership verbs (add/remove) stay unchanged ──
  const alias = product.command("alias").description("Manage domain aliases for a product");

  alias
    .command("add")
    .description("Add domain aliases to a product")
    .argument("<identifier>", "Product ID (prod_…) or slug")
    .argument("<domains...>", "Domain names to add")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findProduct(identifier);
      if (!found) {
        console.error(chalk.red(`Product not found: ${identifier}`));
        process.exit(1);
      }

      const current = await getAliases("product", found.slug);
      const currentSet = new Set(current);
      const added: string[] = [];
      for (const d of domains) {
        if (!currentSet.has(d)) {
          currentSet.add(d);
          added.push(d);
        }
      }
      if (added.length > 0) {
        try {
          await setAliases("product", found.slug, [...currentSet]);
        } catch (err) {
          console.error(
            chalk.red(`Failed to add aliases: ${err instanceof Error ? err.message : err}`),
          );
          return;
        }
      }

      if (opts.json) await writeJson({ added });
      else for (const d of added) console.log(chalk.green(`Added alias: ${d} → ${found.name}`));
    });

  alias
    .command("remove")
    .description("Remove domain aliases from a product")
    .argument("<identifier>", "Product ID (prod_…) or slug")
    .argument("<domains...>", "Domain names to remove")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findProduct(identifier);
      if (!found) {
        console.error(chalk.red(`Product not found: ${identifier}`));
        process.exit(1);
      }

      const current = await getAliases("product", found.slug);
      const currentSet = new Set(current);
      const removed: string[] = [];
      for (const d of domains) {
        if (currentSet.delete(d)) removed.push(d);
        else console.error(chalk.yellow(`Alias "${d}" not found.`));
      }
      if (removed.length > 0) await setAliases("product", found.slug, [...currentSet]);

      if (opts.json) await writeJson({ removed });
      else for (const d of removed) console.log(chalk.green(`Removed alias: ${d}`));
    });

  alias
    .command("list")
    .description("List domain aliases for a product")
    .argument("<identifier>", "Product ID (prod_…) or slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findProduct(identifier);
      if (!found) {
        console.error(chalk.red(`Product not found: ${identifier}`));
        process.exit(1);
      }

      const aliases = await getAliases("product", found.slug);

      if (opts.json) {
        const response: ListResponse<string> = {
          items: aliases,
          pagination: computePagination({
            page: 1,
            pageSize: aliases.length,
            returned: aliases.length,
            totalItems: aliases.length,
          }),
        };
        await writeJson(response);
      } else if (aliases.length === 0)
        console.log(chalk.yellow(`No domain aliases for ${found.name}`));
      else for (const d of aliases) console.log(d);
    });
}
