import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import { existsSync } from "fs";
import { toSlug } from "../../lib/slug.js";
import { logger } from "../../lib/logger.js";
import { isGitHubUrl } from "./add.js";
import {
  findOrg,
  createOrg,
  findSourcesByUrls,
  getOrgAccountByPlatform,
  linkOrgAccount,
  createSource,
} from "../../db/queries.js";

// ── Manifest types ──

interface ManifestAccount {
  platform: string;
  handle: string;
}

interface ManifestSource {
  name: string;
  slug?: string;
  type?: string;
  url: string;
}

interface ManifestOrg {
  name: string;
  slug?: string;
  domain?: string;
  description?: string;
  accounts?: ManifestAccount[];
  sources?: ManifestSource[];
}

interface Manifest {
  organizations?: ManifestOrg[];
  sources?: ManifestSource[];
}

interface ImportReport {
  created: { orgs: number; accounts: number; sources: number };
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

  // Validate org entries
  if (manifest.organizations) {
    for (const [i, org] of (manifest.organizations as ManifestOrg[]).entries()) {
      if (!org.name) {
        throw new Error(`organizations[${i}] is missing required 'name' field`);
      }
      if (org.sources) {
        for (const [j, src] of org.sources.entries()) {
          if (!src.name || !src.url) {
            throw new Error(`organizations[${i}].sources[${j}] is missing required 'name' or 'url' field`);
          }
        }
      }
      if (org.accounts) {
        for (const [j, acc] of org.accounts.entries()) {
          if (!acc.platform || !acc.handle) {
            throw new Error(`organizations[${i}].accounts[${j}] is missing required 'platform' or 'handle' field`);
          }
        }
      }
    }
  }

  // Validate top-level source entries
  if (manifest.sources) {
    for (const [i, src] of (manifest.sources as ManifestSource[]).entries()) {
      if (!src.name || !src.url) {
        throw new Error(`sources[${i}] is missing required 'name' or 'url' field`);
      }
    }
  }

  return manifest as unknown as Manifest;
}

function collectAllUrls(manifest: Manifest): string[] {
  const urls: string[] = [];

  if (manifest.organizations) {
    for (const org of manifest.organizations) {
      if (org.sources) {
        for (const src of org.sources) {
          urls.push(src.url);
        }
      }
    }
  }

  if (manifest.sources) {
    for (const src of manifest.sources) {
      urls.push(src.url);
    }
  }

  return urls;
}

export function registerImportCommand(program: Command) {
  program
    .command("import")
    .description("Import organizations and sources from a manifest file")
    .argument("<file>", "Path to JSON manifest file")
    .option("--dry-run", "Show what would be created without writing")
    .option("--json", "Output as JSON")
    .option("--skip-existing", "Skip sources that already exist (default: error)")
    .addHelpText("after", `
Examples:
  released import manifest.json
  released import manifest.json --dry-run
  released import manifest.json --skip-existing
  released import manifest.json --json`)
    .action(async (file: string, opts: { dryRun?: boolean; json?: boolean; skipExisting?: boolean }) => {
      // 1. Read and parse JSON file
      if (!existsSync(file)) {
        logger.error(`File not found: ${file}`);
        process.exit(1);
      }

      let raw: string;
      try {
        raw = readFileSync(file, "utf-8");
      } catch (err) {
        logger.error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        logger.error("Failed to parse JSON — file is not valid JSON");
        process.exit(1);
      }

      // 2. Validate basic structure
      let manifest: Manifest;
      try {
        manifest = validateManifest(data);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // 3. Collect all source URLs and batch dedup check
      const allUrls = collectAllUrls(manifest);
      const existingSources = await findSourcesByUrls(allUrls);
      const existingUrlSet = new Set(existingSources.map((s) => s.url));

      const report: ImportReport = {
        created: { orgs: 0, accounts: 0, sources: 0 },
        skipped: 0,
        errors: [],
      };

      // 4. Process organizations
      if (manifest.organizations) {
        for (const orgEntry of manifest.organizations) {
          const orgSlug = orgEntry.slug ?? toSlug(orgEntry.name);

          if (opts.dryRun) {
            // Check if org exists
            const existing = await findOrg(orgSlug);
            if (existing) {
              if (!opts.json) {
                logger.info(chalk.yellow(`[dry-run] Org already exists: ${orgEntry.name} (${orgSlug})`));
              }
            } else {
              report.created.orgs++;
              if (!opts.json) {
                logger.info(chalk.green(`[dry-run] Would create org: ${orgEntry.name} (${orgSlug})`));
              }
            }

            // Accounts
            if (orgEntry.accounts) {
              for (const acc of orgEntry.accounts) {
                if (!opts.json) {
                  logger.info(chalk.green(`[dry-run] Would link account: ${acc.platform}/${acc.handle} -> ${orgSlug}`));
                }
                report.created.accounts++;
              }
            }

            // Sources
            if (orgEntry.sources) {
              for (const srcEntry of orgEntry.sources) {
                if (existingUrlSet.has(srcEntry.url)) {
                  report.skipped++;
                  if (!opts.json) {
                    logger.info(chalk.yellow(`[dry-run] Source URL already exists, would skip: ${srcEntry.url}`));
                  }
                } else {
                  report.created.sources++;
                  const srcType = resolveSourceType(srcEntry);
                  if (!opts.json) {
                    logger.info(chalk.green(`[dry-run] Would create source: ${srcEntry.name} [${srcType}] -> ${orgSlug}`));
                  }
                }
              }
            }

            continue;
          }

          // Create or find org
          let org = await findOrg(orgSlug);
          if (org) {
            if (!opts.json) {
              logger.info(chalk.yellow(`Org already exists: ${org.name} (${org.slug})`));
            }
          } else {
            try {
              org = await createOrg(orgEntry.name, {
                slug: orgSlug,
                domain: orgEntry.domain,
                description: orgEntry.description,
              });
              report.created.orgs++;
              if (!opts.json) {
                logger.info(chalk.green(`Created org: ${org.name} (${org.slug})`));
              }
            } catch (err) {
              const msg = `Failed to create org "${orgEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
              report.errors.push(msg);
              if (!opts.json) {
                logger.error(chalk.red(msg));
              }
              continue;
            }
          }

          // Link accounts
          if (orgEntry.accounts) {
            for (const acc of orgEntry.accounts) {
              const existing = await getOrgAccountByPlatform(org.id, acc.platform);
              if (existing) {
                if (!opts.json) {
                  logger.info(chalk.yellow(`Account already linked: ${acc.platform}/${acc.handle}`));
                }
              } else {
                try {
                  await linkOrgAccount(org.id, org.slug, acc.platform, acc.handle);
                  report.created.accounts++;
                  if (!opts.json) {
                    logger.info(chalk.green(`Linked account: ${acc.platform}/${acc.handle} -> ${org.slug}`));
                  }
                } catch (err) {
                  const msg = `Failed to link account ${acc.platform}/${acc.handle}: ${err instanceof Error ? err.message : String(err)}`;
                  report.errors.push(msg);
                  if (!opts.json) {
                    logger.error(chalk.red(msg));
                  }
                }
              }
            }
          }

          // Insert org sources
          if (orgEntry.sources) {
            for (const srcEntry of orgEntry.sources) {
              if (existingUrlSet.has(srcEntry.url)) {
                report.skipped++;
                if (opts.skipExisting) {
                  if (!opts.json) {
                    logger.info(chalk.yellow(`Skipped existing source: ${srcEntry.url}`));
                  }
                } else {
                  const msg = `Source URL already exists: ${srcEntry.url}`;
                  report.errors.push(msg);
                  if (!opts.json) {
                    logger.error(chalk.red(msg));
                  }
                }
                continue;
              }

              const srcSlug = srcEntry.slug ?? toSlug(srcEntry.name);
              const srcType = resolveSourceType(srcEntry);

              try {
                await createSource({
                  name: srcEntry.name,
                  slug: srcSlug,
                  type: srcType,
                  url: srcEntry.url,
                  orgId: org.id,
                });
                report.created.sources++;
                if (!opts.json) {
                  logger.info(chalk.green(`Created source: ${srcEntry.name} (${srcSlug}) [${srcType}] -> ${org.slug}`));
                }
              } catch (err) {
                const msg = `Failed to create source "${srcEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
                report.errors.push(msg);
                if (!opts.json) {
                  logger.error(chalk.red(msg));
                }
              }
            }
          }
        }
      }

      // 5. Process top-level sources
      if (manifest.sources) {
        for (const srcEntry of manifest.sources) {
          if (existingUrlSet.has(srcEntry.url)) {
            report.skipped++;

            if (opts.dryRun) {
              if (!opts.json) {
                logger.info(chalk.yellow(`[dry-run] Source URL already exists, would skip: ${srcEntry.url}`));
              }
              continue;
            }

            if (opts.skipExisting) {
              if (!opts.json) {
                logger.info(chalk.yellow(`Skipped existing source: ${srcEntry.url}`));
              }
            } else {
              const msg = `Source URL already exists: ${srcEntry.url}`;
              report.errors.push(msg);
              if (!opts.json) {
                logger.error(chalk.red(msg));
              }
            }
            continue;
          }

          const srcSlug = srcEntry.slug ?? toSlug(srcEntry.name);
          const srcType = resolveSourceType(srcEntry);

          if (opts.dryRun) {
            report.created.sources++;
            if (!opts.json) {
              logger.info(chalk.green(`[dry-run] Would create source: ${srcEntry.name} (${srcSlug}) [${srcType}]`));
            }
            continue;
          }

          try {
            await createSource({
              name: srcEntry.name,
              slug: srcSlug,
              type: srcType,
              url: srcEntry.url,
            });
            report.created.sources++;
            if (!opts.json) {
              logger.info(chalk.green(`Created source: ${srcEntry.name} (${srcSlug}) [${srcType}]`));
            }
          } catch (err) {
            const msg = `Failed to create source "${srcEntry.name}": ${err instanceof Error ? err.message : String(err)}`;
            report.errors.push(msg);
            if (!opts.json) {
              logger.error(chalk.red(msg));
            }
          }
        }
      }

      // 6. Report
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log("");
        const prefix = opts.dryRun ? "[dry-run] " : "";
        console.log(chalk.bold(`${prefix}Import summary:`));
        console.log(`  Organizations created: ${report.created.orgs}`);
        console.log(`  Accounts linked:       ${report.created.accounts}`);
        console.log(`  Sources created:       ${report.created.sources}`);
        console.log(`  Sources skipped:       ${report.skipped}`);
        if (report.errors.length > 0) {
          console.log(chalk.red(`  Errors:                ${report.errors.length}`));
        }
      }

      if (report.errors.length > 0 && !opts.skipExisting) {
        process.exit(1);
      }
    });
}
