import { Command } from "commander";
import chalk from "chalk";
import { findOrg, createOrg, createSource, isUrlExcluded, findProduct } from "../../db/queries.js";
import { toSlug } from "@releases/core-internal/slug";
import { logger } from "@buildinternet/releases-lib/logger";
import { evaluateChangelog, buildMetadataFromEvaluation } from "../../ai/evaluate.js";
import type { EvaluationResult } from "../../ai/evaluate.js";
import { readFileSync } from "fs";

const VALID_TYPES = ["github", "scrape", "feed", "agent"] as const;
type SourceType = (typeof VALID_TYPES)[number];

function isValidType(t: string): t is SourceType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export function isGitHubUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/.test(url);
}

function mapMethodToType(method: EvaluationResult["recommendedMethod"]): SourceType {
  if (method === "github") return "github";
  if (method === "feed") return "feed";
  return "scrape";
}

interface AddSourceInput {
  name: string;
  url: string;
  type?: string;
  slug?: string;
  org?: string;
  product?: string;
  feedUrl?: string;
  skipEval?: boolean;
  batch?: boolean;
}

interface AddSourceResult {
  name: string;
  slug: string;
  type: string;
  url: string;
  org?: string;
  status: "added" | "error" | "ignored";
  error?: string;
  reason?: string;
}

async function addSingleSource(input: AddSourceInput): Promise<AddSourceResult> {
  const { name, url } = input;

  if (input.type && !isValidType(input.type)) {
    return {
      name,
      slug: input.slug ?? toSlug(name),
      type: input.type,
      url,
      status: "error",
      error: `Invalid type "${input.type}". Must be one of: ${VALID_TYPES.join(", ")}`,
    };
  }

  const slug = input.slug ?? toSlug(name);
  let orgId: string | null = null;
  let orgName: string | null = null;

  // Resolve org early so exclusion check has orgId context
  if (input.org) {
    let org = await findOrg(input.org);
    if (!org) {
      org = await createOrg(input.org, { slug: toSlug(input.org) });
      logger.info(`Created organization: ${org.name} (${org.slug})`);
    }
    orgId = org.id;
    orgName = org.name;
  }

  let productId: string | null = null;
  if (input.product) {
    const prod = await findProduct(input.product);
    if (!prod) {
      return {
        name,
        slug: input.slug ?? toSlug(name),
        type: "scrape",
        url,
        status: "error",
        error: `Product not found: "${input.product}"`,
      };
    }
    productId = prod.id;
    if (!orgId) {
      orgId = prod.orgId;
    }
  }

  // Check exclusions before evaluation to avoid wasting an agent call on blocked URLs
  const exclusion = await isUrlExcluded(url, orgId ?? undefined);
  if (exclusion.excluded) {
    const scopeLabel = exclusion.scope === "blocked" ? "blocked" : "ignored";
    logger.warn(
      `Skipping ${scopeLabel} URL: ${url}${exclusion.reason ? ` (${exclusion.reason})` : ""}`,
    );
    return {
      name,
      slug,
      type: "scrape",
      url,
      org: orgName ?? undefined,
      status: "ignored",
      reason: exclusion.reason,
    };
  }

  // Determine source type and metadata
  let sourceType: SourceType;
  const metadata: Record<string, unknown> = {};
  let evaluationResult: EvaluationResult | null = null;

  if (input.feedUrl) {
    // Explicit feed URL — skip evaluation
    sourceType = (input.type as SourceType) ?? "feed";
    metadata.feedUrl = input.feedUrl;
    metadata.feedType = "unknown";
    metadata.feedDiscoveredAt = new Date().toISOString();
    metadata.noFeedFound = false;
    logger.info(`Using provided feed URL — ${sourceType} adapter`);
  } else if (input.type) {
    // Explicit type — skip evaluation
    sourceType = input.type as SourceType;
  } else if (input.skipEval || input.batch) {
    // Skip evaluation — basic heuristic only
    sourceType = isGitHubUrl(url) ? "github" : "scrape";
    if (sourceType === "github") {
      logger.info("Detected GitHub URL — using github adapter");
    } else {
      logger.info("Skipping evaluation — using scrape adapter");
    }
  } else {
    // Run evaluation
    logger.info("Evaluating changelog source...");
    evaluationResult = await evaluateChangelog(url);
    sourceType = mapMethodToType(evaluationResult.recommendedMethod);
    Object.assign(metadata, buildMetadataFromEvaluation(evaluationResult));
    logger.info(
      `Evaluation: ${evaluationResult.recommendedMethod} (${evaluationResult.confidence}) — using ${sourceType} adapter`,
    );
  }

  // Auto-association for GitHub sources (only if no org specified)
  if (!input.org && sourceType === "github") {
    const ghRepo = evaluationResult?.githubRepo;
    if (ghRepo) {
      const owner = ghRepo.split("/")[0];
      const org = await findOrg(owner);
      if (org) {
        orgId = org.id;
        orgName = org.name;
        logger.info(`Auto-linked to organization "${orgName}"`);
      }
    } else {
      // Fallback: parse owner from URL directly (for skip-eval / batch paths)
      const match = url.match(/github\.com\/([^/]+)\//);
      if (match) {
        const org = await findOrg(match[1]);
        if (org) {
          orgId = org.id;
          orgName = org.name;
          logger.info(`Auto-linked to organization "${orgName}"`);
        }
      }
    }
  }

  try {
    await createSource({
      name,
      slug,
      type: sourceType,
      url,
      orgId,
      productId,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      slug,
      type: sourceType,
      url,
      org: orgName ?? undefined,
      status: "error",
      error: message,
    };
  }

  return { name, slug, type: sourceType, url, org: orgName ?? undefined, status: "added" };
}

export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("Add a new changelog source")
    .argument("[name]", "Display name for the source")
    .option(
      "--type <type>",
      "Source type: github, scrape, feed, or agent (auto-detected from URL if omitted)",
    )
    .option("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization name or slug (creates if not found)")
    .option("--product <product>", "Product slug to assign this source to")
    .option("--name <name>", "Display name for the source (alternative to positional argument)")
    .option("--feed-url <feedUrl>", "Explicit feed URL (skips auto-discovery)")
    .option("--batch <file>", "JSON file with sources to add (use - for stdin)")
    .option("--skip-eval", "Skip changelog evaluation (use basic type detection only)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source add "Next.js" --url https://github.com/vercel/next.js
  releases admin source add "Tailwind Blog" --url https://tailwindcss.com/blog --org "Tailwind Labs"
  releases admin source add "Astro" --url https://astro.build/blog --type scrape
  releases admin source add --name "Astro" --url https://astro.build/blog
  releases admin source add --batch sources.json
  cat sources.json | releases admin source add --batch -`,
    )
    .action(
      async (
        name: string | undefined,
        opts: {
          type?: string;
          url?: string;
          slug?: string;
          org?: string;
          product?: string;
          name?: string;
          feedUrl?: string;
          batch?: string;
          skipEval?: boolean;
          json?: boolean;
        },
      ) => {
        // --- Batch mode ---
        if (opts.batch) {
          let raw: string;
          if (opts.batch === "-") {
            raw = await Bun.stdin.text();
          } else {
            raw = readFileSync(opts.batch, "utf-8");
          }

          let entries: AddSourceInput[];
          try {
            entries = JSON.parse(raw);
          } catch {
            logger.error("Failed to parse batch JSON input");
            process.exit(1);
          }

          if (!Array.isArray(entries)) {
            logger.error("Batch input must be a JSON array");
            process.exit(1);
          }

          // Validate each entry has required fields
          for (const [i, entry] of entries.entries()) {
            if (!entry.name || !entry.url) {
              logger.error(`Entry ${i} is missing required "name" or "url" field`);
              process.exit(1);
            }
          }

          const results: AddSourceResult[] = [];
          let hasError = false;

          for (const entry of entries) {
            const result = await addSingleSource({ ...entry, batch: true });
            results.push(result);

            if (result.status === "error") {
              hasError = true;
              if (!opts.json) {
                logger.error(chalk.red(`Failed to add ${result.name}: ${result.error}`));
              }
            } else if (result.status === "ignored") {
              if (!opts.json) {
                logger.info(
                  chalk.yellow(
                    `Skipped (ignored): ${result.name} (${result.url})${result.reason ? ` — ${result.reason}` : ""}`,
                  ),
                );
              }
            } else if (!opts.json) {
              const orgLabel = result.org ? ` [org: ${result.org}]` : "";
              logger.info(
                chalk.green(
                  `Source added: ${result.name} (${result.slug}) [${result.type}]${orgLabel}`,
                ),
              );
            }
          }

          if (opts.json) {
            console.log(JSON.stringify(results, null, 2));
          }

          if (hasError) {
            process.exit(1);
          }
          return;
        }

        // --- Single-add mode ---
        const effectiveName = name ?? opts.name;
        if (!effectiveName) {
          console.error("Error: missing required argument: name\n");
          console.error(
            '  releases admin source add "My Source" --url https://example.com/changelog',
          );
          console.error(
            '  releases admin source add --name "My Source" --url https://example.com/changelog',
          );
          console.error("  releases admin source add --batch sources.json");
          process.exit(1);
        }
        if (!opts.url) {
          console.error("Error: missing required option: --url\n");
          console.error(
            `  releases admin source add "${effectiveName}" --url https://example.com/changelog`,
          );
          process.exit(1);
        }

        const result = await addSingleSource({
          name: effectiveName,
          url: opts.url,
          type: opts.type,
          slug: opts.slug,
          org: opts.org,
          product: opts.product,
          feedUrl: opts.feedUrl,
          skipEval: opts.skipEval,
        });

        if (result.status === "error") {
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            logger.error(chalk.red(result.error!));
          }
          process.exit(1);
        }

        if (result.status === "ignored") {
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          }
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const orgLabel = result.org ? ` [org: ${result.org}]` : "";
          const typeLabel = !opts.type ? ` (auto-detected: ${result.type})` : "";
          console.log(
            chalk.green(`Source added: ${result.name} (${result.slug})${typeLabel}${orgLabel}`),
          );
        }
      },
    );
}
