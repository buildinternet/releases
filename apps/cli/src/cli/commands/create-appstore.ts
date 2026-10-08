import { Command } from "commander";
import chalk from "chalk";
import { createAppStoreSource } from "../../api/sources.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";

const TRACK_ID_RE = /^\d+$/;
const VALID_PLATFORMS = ["ios", "macos"] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

/** The wire fields `POST /v1/sources/appstore` accepts for the identifier. */
export type AppStoreInput = { url: string } | { trackId: string } | { error: string };

/**
 * True when `value` points at an App Store listing host (`apps.apple.com`, any
 * subdomain), with or without a scheme. Shared with the generic `create` guard
 * so a pasted App Store URL is redirected rather than mis-fetched as a scrape.
 */
export function isAppStoreUrl(value: string): boolean {
  let candidate = value.trim();
  if (!candidate) return false;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const { hostname } = new URL(candidate);
    return /(^|\.)apps\.apple\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

/** True when `value` is an `appstore:<trackId>` coordinate (case-insensitive). */
export function isAppStoreCoordinate(value: string): boolean {
  return /^appstore:/i.test(value.trim());
}

/**
 * Classify an operator-supplied App Store identifier into the wire fields the
 * endpoint accepts. Strips an optional `appstore:` coordinate prefix
 * client-side — the API has no `appstore:` coordinate path (deferred in
 * monorepo #1160); it only takes a bare numeric `trackId` or an
 * `apps.apple.com` URL.
 */
export function parseAppStoreInput(raw: string): AppStoreInput {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { error: "Provide an apps.apple.com URL, a numeric track ID, or appstore:<trackId>." };
  }
  const stripped = trimmed.replace(/^appstore:/i, "").trim();
  if (TRACK_ID_RE.test(stripped)) return { trackId: stripped };
  if (isAppStoreUrl(stripped)) return { url: stripped };
  return {
    error: `Could not parse "${raw}". Expected an apps.apple.com URL, a numeric track ID, or appstore:<trackId>.`,
  };
}

type CreateAppStoreOpts = {
  platform?: string;
  org?: string;
  product?: string;
  storefront?: string;
  json?: boolean;
  dryRun?: boolean;
};

export async function createAppStoreAction(
  identifier: string,
  opts: CreateAppStoreOpts,
): Promise<void> {
  const platform = opts.platform ?? "ios";
  if (!(VALID_PLATFORMS as readonly string[]).includes(platform)) {
    logger.error(
      chalk.red(`Invalid --platform "${platform}". Must be one of: ${VALID_PLATFORMS.join(", ")}`),
    );
    process.exit(1);
  }

  const parsed = parseAppStoreInput(identifier);
  if ("error" in parsed) {
    logger.error(chalk.red(parsed.error));
    process.exit(1);
  }

  const params = {
    ...parsed,
    platform: platform as Platform,
    storefront: opts.storefront,
    orgSlug: opts.org,
    productSlug: opts.product,
  };

  if (opts.dryRun) {
    const body = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
    );
    if (opts.json) {
      await writeJson(markDryRun({ wouldPost: "/v1/sources/appstore", body }));
    } else {
      logger.info(chalk.yellow("[dry-run] Would POST /v1/sources/appstore"));
      for (const [k, v] of Object.entries(body)) logger.info(`  ${k}: ${v}`);
      logger.info(
        chalk.dim(
          "Note: the app name and slug are resolved from the App Store listing at create time.",
        ),
      );
    }
    return;
  }

  let result;
  try {
    result = await createAppStoreSource(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(chalk.red(`Failed to create App Store source: ${msg}`));
    process.exit(1);
  }

  if (opts.json) {
    await writeJson(result);
    return;
  }

  const { source, releaseCount, status } = result;
  const plat = chalk.dim(`[${platform}]`);
  const releaseLabel = `${releaseCount} release${releaseCount === 1 ? "" : "s"}`;
  if (status === "existing") {
    logger.info(
      chalk.yellow(
        `App Store source already indexed: ${source.name} (${source.slug}) ${plat} — ${releaseLabel}`,
      ),
    );
  } else {
    logger.info(
      chalk.green(
        `App Store source created: ${source.name} (${source.slug}) ${plat} — ${releaseLabel} indexed`,
      ),
    );
  }
}

export function registerCreateAppStoreCommand(program: Command) {
  program
    .command("create-appstore")
    .description(
      "Create an App Store source (resolves the listing, mints the first release, backfills the app icon)",
    )
    .argument("<url-or-id>", "apps.apple.com URL, numeric track ID, or appstore:<trackId>")
    .option("--platform <platform>", "App Store platform: ios or macos", "ios")
    .option("--org <slug>", "Organization slug (defaults to the App Store seller name)")
    .option(
      "--product <slug>",
      "Existing product slug to attach to — create the product first for a clean name (see below)",
    )
    .option("--storefront <code>", "App Store storefront country code", "us")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show the request that would be sent without creating")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source create-appstore https://apps.apple.com/us/app/slack/id618783545 --org slack --product slack
  releases admin source create-appstore appstore:618783545 --platform ios --org slack --product slack
  releases admin source create-appstore 1496833156 --platform macos

Clean product names:
  The endpoint names a NEW product after the (often verbose) App Store title
  (e.g. "Shopify: Sell online/in person"). To control the name, create the
  product first, then reference it with --product:
    releases admin product create "Shopify" --org shopify
    releases admin source create-appstore <url-or-id> --org shopify --product shopify`,
    )
    .action(createAppStoreAction);
}
