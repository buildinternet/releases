import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import type { CreateStubOrgBody } from "@buildinternet/releases-api-types";
import { createStubOrg, createStubOrgFromDomain, promoteOrg } from "../../api/orgs.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";

// ── Stub-tier org verbs (#1947 / releases-cli#355) ───────────────────────────
//
// A "stub" org is known only by its declared release locations — identity +
// locators, no processed sources. Three admin routes back these verbs:
//   POST /v1/orgs/stub               → `admin org create-stub`
//   POST /v1/orgs/stub-from-domain   → `admin org create-stub-from-domain`
//   POST /v1/orgs/:slug/promote      → `admin org promote`

export const LOCATOR_KEYS = ["url", "feed", "github", "appstore", "file"] as const;

type Locator = NonNullable<CreateStubOrgBody["releases"]>[number];

/** Parse one `--location` value: a JSON object carrying at least one locator
 *  key (`url` / `feed` / `github` / `appstore` / `file`). Fails fast before
 *  any network call, mirroring the category-validation pattern in org.ts. */
function parseLocation(value: string): Locator {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger.error(
      `Invalid --location (not valid JSON): ${value}\n` +
        `Expected a JSON object, e.g. --location '{"url":"https://example.com/changelog"}'`,
    );
    process.exit(1);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.error(`Invalid --location (must be a JSON object): ${value}`);
    process.exit(1);
  }
  const record = parsed as Record<string, unknown>;
  if (!LOCATOR_KEYS.some((key) => typeof record[key] === "string")) {
    logger.error(
      `Invalid --location (needs at least one locator key: ${LOCATOR_KEYS.join(", ")}): ${value}`,
    );
    process.exit(1);
  }
  return record as Locator;
}

/** Read `--from-file`: either a bare JSON array of locators, or a full
 *  CreateStubOrgBody object (name/slug/domain/products/releases…). */
function readFromFile(path: string): Partial<CreateStubOrgBody> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    logger.error(`Could not read --from-file "${path}": ${(err as Error).message}`);
    process.exit(1);
  }
  if (Array.isArray(parsed)) return { releases: parsed as Locator[] };
  if (typeof parsed === "object" && parsed !== null) return parsed as Partial<CreateStubOrgBody>;
  logger.error(`--from-file "${path}" must contain a JSON object or array`);
  process.exit(1);
}

export type OrgCreateStubOpts = {
  slug?: string;
  domain?: string;
  description?: string;
  location: string[];
  fromFile?: string;
  json?: boolean;
};

export async function orgCreateStubAction(name: string, opts: OrgCreateStubOpts): Promise<void> {
  // File first, explicit flags win over file-provided fields when both given.
  const fileBody = opts.fromFile ? readFromFile(opts.fromFile) : {};
  const flagLocations = (opts.location ?? []).map(parseLocation);
  const releases =
    flagLocations.length > 0 ? [...(fileBody.releases ?? []), ...flagLocations] : fileBody.releases;

  const body: CreateStubOrgBody = {
    ...fileBody,
    name,
    ...(opts.slug ? { slug: opts.slug } : {}),
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    ...(releases ? { releases } : {}),
  };

  const created = await createStubOrg(body);
  if (opts.json) {
    await writeJson(created);
    return;
  }
  logger.info(
    `Created stub organization: ${created.name} (${created.slug})` +
      ` — ${created.locationCount} location${created.locationCount === 1 ? "" : "s"},` +
      ` ${created.productCount} product${created.productCount === 1 ? "" : "s"}`,
  );
  logger.info(chalk.dim(`Promote it later with: releases admin org promote ${created.slug}`));
}

export type OrgStubFromDomainOpts = { dryRun?: boolean; json?: boolean };

export async function orgCreateStubFromDomainAction(
  domain: string,
  opts: OrgStubFromDomainOpts,
): Promise<void> {
  const result = await createStubOrgFromDomain(domain, { dryRun: opts.dryRun });
  if (opts.json) {
    await writeJson(opts.dryRun ? markDryRun(result) : result);
    return;
  }
  if (opts.dryRun) {
    if (result.plan) logger.warn(`[dry-run] Would create stub org from ${domain}:`);
    else logger.warn(`[dry-run] Would skip ${domain}: ${result.skippedReason}`);
    if (result.plan) console.log(JSON.stringify(result.plan, null, 2));
    return;
  }
  if (!result.created) {
    logger.error(`Stub not created for ${domain}: ${result.skippedReason}`);
    process.exit(1);
  }
  logger.info(
    `Created stub organization from ${domain} (${result.orgId})` +
      ` — ${result.locationCount ?? 0} locations, ${result.productCount ?? 0} products`,
  );
}

export type OrgPromoteOpts = { dryRun?: boolean; json?: boolean };

export async function orgPromoteAction(slug: string, opts: OrgPromoteOpts): Promise<void> {
  const result = await promoteOrg(slug, { dryRun: opts.dryRun });
  if (opts.json) {
    await writeJson(opts.dryRun ? markDryRun(result) : result);
    return;
  }
  if (opts.dryRun) {
    logger.warn(`[dry-run] Would promote ${slug}:`);
    console.log(JSON.stringify(result.plan ?? result, null, 2));
    return;
  }
  if (result.alreadyTracked) {
    logger.info(`Organization "${slug}" is already tracked — no-op.`);
    return;
  }
  logger.info(
    `Promoted ${slug} to tracked — ${result.sourcesCreated} source${result.sourcesCreated === 1 ? "" : "s"} created,` +
      ` ${result.sourcesMatched} matched, ${result.locatorsStamped} locators stamped`,
  );
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerOrgStubCommands(org: Command): void {
  org
    .command("create-stub")
    .description("Create a stub-tier organization (declared locations, no sources)")
    .argument("<name>", "Organization name")
    .option("--slug <slug>", "Custom slug")
    .option("--domain <domain>", "Primary domain")
    .option("--description <text>", "Brief product description")
    .option(
      "--location <json>",
      'Release locator as JSON (repeatable), e.g. \'{"url":"https://example.com/changelog"}\'',
      collect,
      [] as string[],
    )
    .option("--from-file <path>", "JSON file with a locations array or a full stub-org body")
    .option("--json", "Output as JSON")
    .action(orgCreateStubAction);

  org
    .command("create-stub-from-domain")
    .description("Create a stub org from a domain's /.well-known/releases.json manifest")
    .argument("<domain>", "Domain to fetch the manifest from")
    .option("--dry-run", "Preview the stub that would be created without writing")
    .option("--json", "Output as JSON")
    .action(orgCreateStubFromDomainAction);

  org
    .command("promote")
    .description("Promote a stub org to tracked (materialize locations into sources)")
    .argument("<slug>", "Organization slug or org_… ID")
    .option("--dry-run", "Preview the materialization plan without writing")
    .option("--json", "Output as JSON")
    .action(orgPromoteAction);
}
