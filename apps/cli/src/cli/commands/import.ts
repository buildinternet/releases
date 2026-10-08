import { Command } from "commander";
import chalk from "chalk";
import { toSlug } from "@buildinternet/releases-core/slug";
import { logger } from "@buildinternet/releases-lib/logger";
import { isGitHubUrl } from "./add.js";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { readContentArg } from "../../lib/input.js";
import {
  findOrg,
  createOrg,
  getOrgAccountsBySlug,
  linkOrgAccount,
  addTagsToOrg,
} from "../../api/orgs.js";
import { findProduct, createProduct, addTagsToProduct } from "../../api/products.js";
import { findSourcesByUrls, createSource } from "../../api/sources.js";

interface ManifestAccount {
  platform: string;
  handle: string;
}

/**
 * Split desired org accounts into the ones to link vs. the ones already linked,
 * keying on the exact `(platform, handle)` pair — not platform alone (#283).
 *
 * `org_accounts` is one-to-many (the server's unique index is on the pair, and
 * the DELETE route keys on it too), so an org can hold a second handle on a
 * platform it's already linked to. Keying on platform alone silently skipped
 * that second handle. Matching is case-sensitive to mirror the server's index.
 * A pair listed twice in one manifest links once, then reports the rest as
 * already linked.
 */
export function partitionAccounts(
  existing: Array<{ platform: string; handle: string }>,
  desired: Array<{ platform: string; handle: string }>,
): { toLink: ManifestAccount[]; alreadyLinked: ManifestAccount[] } {
  const seen = new Set(existing.map(accountKey));
  const toLink: ManifestAccount[] = [];
  const alreadyLinked: ManifestAccount[] = [];
  for (const acc of desired) {
    const key = accountKey(acc);
    if (seen.has(key)) {
      alreadyLinked.push(acc);
    } else {
      seen.add(key);
      toLink.push(acc);
    }
  }
  return { toLink, alreadyLinked };
}

const accountKey = (a: { platform: string; handle: string }) => `${a.platform}/${a.handle}`;

interface ManifestSource {
  name: string;
  slug?: string;
  type?: string;
  url: string;
}

interface ManifestProduct {
  name: string;
  slug?: string;
  url?: string;
  description?: string;
  category?: string;
  tags?: string[];
  sources?: ManifestSource[];
}

interface ManifestOrg {
  name: string;
  slug?: string;
  domain?: string;
  description?: string;
  category?: string;
  tags?: string[];
  accounts?: ManifestAccount[];
  products?: ManifestProduct[];
  sources?: ManifestSource[];
}

interface Manifest {
  organizations?: ManifestOrg[];
  sources?: ManifestSource[];
}

interface ImportReport {
  created: { orgs: number; accounts: number; products: number; sources: number };
  skipped: number;
  errors: string[];
}

function resolveSourceType(source: ManifestSource): string {
  if (source.type) return source.type;
  if (isGitHubUrl(source.url)) return "github";
  return "scrape";
}

function validateManifest(data: unknown): Manifest {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Manifest must be a JSON object");
  }

  const manifest = data as Record<string, unknown>;

  if (!manifest.organizations && !manifest.sources) {
    throw new Error("Manifest must contain at least one of 'organizations' or 'sources'");
  }

  if (manifest.organizations && !Array.isArray(manifest.organizations)) {
    throw new Error("'organizations' must be an array");
  }

  if (manifest.sources && !Array.isArray(manifest.sources)) {
    throw new Error("'sources' must be an array");
  }

  if (manifest.organizations) {
    for (const [i, org] of (manifest.organizations as ManifestOrg[]).entries()) {
      if (!org.name) throw new Error(`organizations[${i}] is missing required 'name' field`);
      if (org.sources) {
        for (const [j, src] of org.sources.entries()) {
          if (!src.name || !src.url) {
            throw new Error(
              `organizations[${i}].sources[${j}] is missing required 'name' or 'url'`,
            );
          }
        }
      }
      if (org.accounts) {
        for (const [j, acc] of org.accounts.entries()) {
          if (!acc.platform || !acc.handle) {
            throw new Error(
              `organizations[${i}].accounts[${j}] is missing required 'platform' or 'handle'`,
            );
          }
        }
      }
      if (org.category && !isValidCategory(org.category)) {
        throw new Error(`organizations[${i}].category "${org.category}" is not a valid category`);
      }
      if (org.products) {
        for (const [k, prod] of org.products.entries()) {
          if (!prod.name)
            throw new Error(`organizations[${i}].products[${k}] is missing required 'name' field`);
          if (prod.category && !isValidCategory(prod.category)) {
            throw new Error(
              `organizations[${i}].products[${k}].category "${prod.category}" is not a valid category`,
            );
          }
          if (prod.sources) {
            for (const [j, src] of prod.sources.entries()) {
              if (!src.name || !src.url) {
                throw new Error(
                  `organizations[${i}].products[${k}].sources[${j}] is missing required 'name' or 'url'`,
                );
              }
            }
          }
        }
      }
    }
  }

  if (manifest.sources) {
    for (const [i, src] of (manifest.sources as ManifestSource[]).entries()) {
      if (!src.name || !src.url)
        throw new Error(`sources[${i}] is missing required 'name' or 'url'`);
    }
  }

  return manifest as unknown as Manifest;
}

function collectAllUrls(manifest: Manifest): string[] {
  const urls: string[] = [];
  if (manifest.organizations) {
    for (const org of manifest.organizations) {
      if (org.sources) for (const src of org.sources) urls.push(src.url);
      if (org.products) {
        for (const prod of org.products) {
          if (prod.sources) for (const src of prod.sources) urls.push(src.url);
        }
      }
    }
  }
  if (manifest.sources) for (const src of manifest.sources) urls.push(src.url);
  return urls;
}

export function registerImportCommand(program: Command) {
  program
    .command("import")
    .description("Import organizations and sources from a manifest file")
    .argument("<file>", 'Path to JSON manifest file, or "-" to read from stdin')
    .option("--dry-run", "Show what would be created without writing")
    .option("--json", "Output as JSON")
    .option("--skip-existing", "Skip sources that already exist (default: error)")
    .addHelpText(
      "after",
      `
Examples:
  releases import manifest.json
  cat manifest.json | releases import -`,
    )
    .action(
      async (file: string, opts: { dryRun?: boolean; json?: boolean; skipExisting?: boolean }) => {
        const raw = await readContentArg(file);

        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          logger.error("Failed to parse JSON — file is not valid JSON");
          process.exit(1);
        }

        let manifest: Manifest;
        try {
          manifest = validateManifest(data);
        } catch (err) {
          logger.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        const allUrls = collectAllUrls(manifest);
        const existingSources = await findSourcesByUrls(allUrls);
        const existingUrlSet = new Set(existingSources.map((s) => s.url));

        const report: ImportReport = {
          created: { orgs: 0, accounts: 0, products: 0, sources: 0 },
          skipped: 0,
          errors: [],
        };

        if (manifest.organizations) {
          for (const orgEntry of manifest.organizations) {
            const orgSlug = orgEntry.slug ?? toSlug(orgEntry.name);

            if (opts.dryRun) {
              // eslint-disable-next-line no-await-in-loop
              const existing = await findOrg(orgSlug);
              if (existing) {
                if (!opts.json)
                  logger.info(
                    chalk.yellow(`[dry-run] Org already exists: ${orgEntry.name} (${orgSlug})`),
                  );
              } else {
                report.created.orgs++;
                if (!opts.json)
                  logger.info(
                    chalk.green(`[dry-run] Would create org: ${orgEntry.name} (${orgSlug})`),
                  );
              }

              if (orgEntry.accounts) {
                // Mirror the apply-path dedup so the preview is honest about a
                // second handle on an already-linked platform (#283). A to-be-
                // created org has no accounts yet, so everything would link.
                // eslint-disable-next-line no-await-in-loop
                const linked = existing ? await getOrgAccountsBySlug(orgSlug) : [];
                const { toLink, alreadyLinked } = partitionAccounts(linked, orgEntry.accounts);
                for (const acc of alreadyLinked) {
                  if (!opts.json)
                    logger.info(
                      chalk.yellow(
                        `[dry-run] Account already linked: ${acc.platform}/${acc.handle}`,
                      ),
                    );
                }
                for (const acc of toLink) {
                  if (!opts.json)
                    logger.info(
                      chalk.green(
                        `[dry-run] Would link account: ${acc.platform}/${acc.handle} -> ${orgSlug}`,
                      ),
                    );
                  report.created.accounts++;
                }
              }

              if (orgEntry.products) {
                for (const prodEntry of orgEntry.products) {
                  report.created.products++;
                  if (!opts.json)
                    logger.info(
                      chalk.green(
                        `[dry-run] Would create product: ${prodEntry.name} -> ${orgSlug}`,
                      ),
                    );
                  if (prodEntry.sources) {
                    for (const srcEntry of prodEntry.sources) {
                      if (existingUrlSet.has(srcEntry.url)) {
                        report.skipped++;
                        if (!opts.json)
                          logger.info(
                            chalk.yellow(`[dry-run] Source URL already exists: ${srcEntry.url}`),
                          );
                      } else {
                        report.created.sources++;
                        const srcType = resolveSourceType(srcEntry);
                        if (!opts.json)
                          logger.info(
                            chalk.green(
                              `[dry-run] Would create source: ${srcEntry.name} [${srcType}] -> ${prodEntry.name}`,
                            ),
                          );
                      }
                    }
                  }
                }
              }

              if (orgEntry.sources) {
                for (const srcEntry of orgEntry.sources) {
                  if (existingUrlSet.has(srcEntry.url)) {
                    report.skipped++;
                    if (!opts.json)
                      logger.info(
                        chalk.yellow(`[dry-run] Source URL already exists: ${srcEntry.url}`),
                      );
                  } else {
                    report.created.sources++;
                    const srcType = resolveSourceType(srcEntry);
                    if (!opts.json)
                      logger.info(
                        chalk.green(
                          `[dry-run] Would create source: ${srcEntry.name} [${srcType}] -> ${orgSlug}`,
                        ),
                      );
                  }
                }
              }

              continue;
            }

            // Org creation gates subsequent product/source creation — sequential by design.
            // eslint-disable-next-line no-await-in-loop
            let org = await findOrg(orgSlug);
            if (org) {
              if (!opts.json)
                logger.info(chalk.yellow(`Org already exists: ${org.name} (${org.slug})`));
            } else {
              try {
                // eslint-disable-next-line no-await-in-loop
                org = await createOrg(orgEntry.name, {
                  slug: orgSlug,
                  domain: orgEntry.domain,
                  description: orgEntry.description,
                  category: orgEntry.category,
                });
                report.created.orgs++;
                if (!opts.json) logger.info(chalk.green(`Created org: ${org.name} (${org.slug})`));
              } catch (err) {
                const msg = `Failed to create org "${orgEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                report.errors.push(msg);
                if (!opts.json) logger.error(chalk.red(msg));
                continue;
              }
              if (orgEntry.tags && orgEntry.tags.length > 0) {
                // eslint-disable-next-line no-await-in-loop
                await addTagsToOrg(org.id, orgEntry.tags);
              }
            }

            if (orgEntry.accounts) {
              // Dedup on the exact (platform, handle) pair (#283): an org can
              // hold a second handle on a platform it's already linked to.
              // eslint-disable-next-line no-await-in-loop
              const linked = await getOrgAccountsBySlug(org.slug);
              const { toLink, alreadyLinked } = partitionAccounts(linked, orgEntry.accounts);
              for (const acc of alreadyLinked) {
                if (!opts.json)
                  logger.info(
                    chalk.yellow(`Account already linked: ${acc.platform}/${acc.handle}`),
                  );
              }
              for (const acc of toLink) {
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await linkOrgAccount(org.slug, acc.platform, acc.handle);
                  report.created.accounts++;
                  if (!opts.json)
                    logger.info(
                      chalk.green(`Linked account: ${acc.platform}/${acc.handle} -> ${org.slug}`),
                    );
                } catch (err) {
                  const msg = `Failed to link account ${acc.platform}/${acc.handle}: ${err instanceof Error ? err.message : String(err)}`;
                  report.errors.push(msg);
                  if (!opts.json) logger.error(chalk.red(msg));
                }
              }
            }

            if (orgEntry.products) {
              for (const prodEntry of orgEntry.products) {
                const prodSlug = prodEntry.slug ?? toSlug(prodEntry.name);
                // Product creation gates child source creation — sequential by design.
                // eslint-disable-next-line no-await-in-loop
                let prod = await findProduct(prodSlug);

                if (prod) {
                  if (!opts.json)
                    logger.info(
                      chalk.yellow(`Product already exists: ${prod.name} (${prod.slug})`),
                    );
                } else {
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    prod = await createProduct(org.id, prodEntry.name, {
                      slug: prodSlug,
                      url: prodEntry.url,
                      description: prodEntry.description,
                      category: prodEntry.category,
                    });
                    report.created.products++;
                    if (!opts.json)
                      logger.info(
                        chalk.green(`Created product: ${prod.name} (${prod.slug}) -> ${org.slug}`),
                      );
                  } catch (err) {
                    const msg = `Failed to create product "${prodEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                    report.errors.push(msg);
                    if (!opts.json) logger.error(chalk.red(msg));
                    continue;
                  }
                  if (prodEntry.tags && prodEntry.tags.length > 0) {
                    // eslint-disable-next-line no-await-in-loop
                    await addTagsToProduct(prod.id, prodEntry.tags);
                  }
                }

                if (prodEntry.sources) {
                  for (const srcEntry of prodEntry.sources) {
                    if (existingUrlSet.has(srcEntry.url)) {
                      report.skipped++;
                      if (opts.skipExisting) {
                        if (!opts.json)
                          logger.info(chalk.yellow(`Skipped existing source: ${srcEntry.url}`));
                      } else {
                        const msg = `Source URL already exists: ${srcEntry.url}`;
                        report.errors.push(msg);
                        if (!opts.json) logger.error(chalk.red(msg));
                      }
                      continue;
                    }

                    const srcSlug = srcEntry.slug ?? toSlug(srcEntry.name);
                    const srcType = resolveSourceType(srcEntry);

                    try {
                      // eslint-disable-next-line no-await-in-loop
                      await createSource({
                        name: srcEntry.name,
                        slug: srcSlug,
                        type: srcType,
                        url: srcEntry.url,
                        orgId: org.id,
                        productId: prod.id,
                      });
                      report.created.sources++;
                      if (!opts.json)
                        logger.info(
                          chalk.green(
                            `Created source: ${srcEntry.name} (${srcSlug}) [${srcType}] -> ${prod.slug}`,
                          ),
                        );
                    } catch (err) {
                      const msg = `Failed to create source "${srcEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                      report.errors.push(msg);
                      if (!opts.json) logger.error(chalk.red(msg));
                    }
                  }
                }
              }
            }

            if (orgEntry.sources) {
              for (const srcEntry of orgEntry.sources) {
                if (existingUrlSet.has(srcEntry.url)) {
                  report.skipped++;
                  if (opts.skipExisting) {
                    if (!opts.json)
                      logger.info(chalk.yellow(`Skipped existing source: ${srcEntry.url}`));
                  } else {
                    const msg = `Source URL already exists: ${srcEntry.url}`;
                    report.errors.push(msg);
                    if (!opts.json) logger.error(chalk.red(msg));
                  }
                  continue;
                }

                const srcSlug = srcEntry.slug ?? toSlug(srcEntry.name);
                const srcType = resolveSourceType(srcEntry);

                try {
                  // eslint-disable-next-line no-await-in-loop
                  await createSource({
                    name: srcEntry.name,
                    slug: srcSlug,
                    type: srcType,
                    url: srcEntry.url,
                    orgId: org.id,
                  });
                  report.created.sources++;
                  if (!opts.json)
                    logger.info(
                      chalk.green(
                        `Created source: ${srcEntry.name} (${srcSlug}) [${srcType}] -> ${org.slug}`,
                      ),
                    );
                } catch (err) {
                  const msg = `Failed to create source "${srcEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                  report.errors.push(msg);
                  if (!opts.json) logger.error(chalk.red(msg));
                }
              }
            }
          }
        }

        if (manifest.sources) {
          for (const srcEntry of manifest.sources) {
            if (existingUrlSet.has(srcEntry.url)) {
              report.skipped++;

              if (opts.dryRun) {
                if (!opts.json)
                  logger.info(chalk.yellow(`[dry-run] Source URL already exists: ${srcEntry.url}`));
                continue;
              }

              if (opts.skipExisting) {
                if (!opts.json)
                  logger.info(chalk.yellow(`Skipped existing source: ${srcEntry.url}`));
              } else {
                const msg = `Source URL already exists: ${srcEntry.url}`;
                report.errors.push(msg);
                if (!opts.json) logger.error(chalk.red(msg));
              }
              continue;
            }

            const srcSlug = srcEntry.slug ?? toSlug(srcEntry.name);
            const srcType = resolveSourceType(srcEntry);

            if (opts.dryRun) {
              report.created.sources++;
              if (!opts.json)
                logger.info(
                  chalk.green(
                    `[dry-run] Would create source: ${srcEntry.name} (${srcSlug}) [${srcType}]`,
                  ),
                );
              continue;
            }

            try {
              // eslint-disable-next-line no-await-in-loop
              await createSource({
                name: srcEntry.name,
                slug: srcSlug,
                type: srcType,
                url: srcEntry.url,
              });
              report.created.sources++;
              if (!opts.json)
                logger.info(
                  chalk.green(`Created source: ${srcEntry.name} (${srcSlug}) [${srcType}]`),
                );
            } catch (err) {
              const msg = `Failed to create source "${srcEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
              report.errors.push(msg);
              if (!opts.json) logger.error(chalk.red(msg));
            }
          }
        }

        if (opts.json) {
          await writeJson(opts.dryRun ? markDryRun(report) : report);
        } else {
          console.log("");
          const prefix = opts.dryRun ? "[dry-run] " : "";
          console.log(chalk.bold(`${prefix}Import summary:`));
          console.log(`  Organizations created: ${report.created.orgs}`);
          console.log(`  Accounts linked:       ${report.created.accounts}`);
          console.log(`  Products created:      ${report.created.products}`);
          console.log(`  Sources created:       ${report.created.sources}`);
          console.log(`  Sources skipped:       ${report.skipped}`);
          if (report.errors.length > 0) {
            console.log(chalk.red(`  Errors:                ${report.errors.length}`));
          }
        }

        if (report.errors.length > 0 && !opts.skipExisting) process.exit(1);
      },
    );
}
