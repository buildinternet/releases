import { Command } from "commander";
import chalk from "chalk";
import { findProduct } from "../../api/products.js";
import { createVideoSource } from "../../api/sources.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";

/**
 * True when `value` points at a supported video host. YouTube only today
 * (`youtube.com` incl. subdomains like `m.`/`music.`, or `youtu.be`), with or
 * without a scheme. Shared with the generic `create` guard so a pasted YouTube
 * URL is redirected to `create-video` rather than mis-fetched as a `scrape`/
 * `feed` source — a generic feed source over a YouTube URL silently produces
 * empty release bodies (the feed parser drops `media:group/media:description`).
 * See issue #1260.
 */
export function isVideoUrl(value: string): boolean {
  let candidate = value.trim();
  if (!candidate) return false;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const { hostname } = new URL(candidate);
    return /(^|\.)youtube\.com$/i.test(hostname) || /^youtu\.be$/i.test(hostname);
  } catch {
    return false;
  }
}

/** Resolved provider + channel display name, pulled from the source's metadata JSON. */
function videoMetaFromSource(metadata: string | null): { provider?: string; channel?: string } {
  if (!metadata) return {};
  try {
    const block = (
      JSON.parse(metadata) as {
        video?: { provider?: string; channel?: { title?: string; playlistTitle?: string } };
      } | null
    )?.video;
    return {
      provider: block?.provider,
      channel: block?.channel?.playlistTitle ?? block?.channel?.title,
    };
  } catch {
    return {};
  }
}

type CreateVideoOpts = {
  org?: string;
  product?: string;
  json?: boolean;
  dryRun?: boolean;
};

export async function createVideoAction(url: string, opts: CreateVideoOpts): Promise<void> {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    logger.error(chalk.red("Provide a YouTube channel or playlist URL."));
    process.exit(1);
  }
  if (!isVideoUrl(trimmed)) {
    logger.error(
      chalk.red(
        `Could not recognize "${url}" as a video URL. Expected a YouTube channel or playlist URL (youtube.com / youtu.be).`,
      ),
    );
    process.exit(1);
  }
  if (!opts.org) {
    logger.error(
      chalk.red("Video sources require --org <slug> (no org is derived from the channel feed)."),
    );
    process.exit(1);
  }

  // The endpoint accepts `orgSlug` OR `orgId`. Forward a typed `org_…`
  // identifier as `orgId`; otherwise treat the value as a slug.
  const orgIsTypedId = opts.org.startsWith("org_");
  const orgSlug = orgIsTypedId ? undefined : opts.org;
  const orgId = orgIsTypedId ? opts.org : undefined;

  if (opts.dryRun) {
    // Show the planned request without writing. Skip the product slug→id
    // lookup so dry-run stays network-free; the resolution happens at create
    // time on the real path.
    const preview: Record<string, string> = { url: trimmed };
    if (orgId) preview.orgId = orgId;
    if (orgSlug) preview.orgSlug = orgSlug;
    if (opts.product) preview.product = opts.product;
    if (opts.json) {
      await writeJson(markDryRun({ wouldPost: "/v1/sources/video", body: preview }));
    } else {
      logger.info(chalk.yellow("[dry-run] Would POST /v1/sources/video"));
      for (const [k, v] of Object.entries(preview)) logger.info(`  ${k}: ${v}`);
      if (opts.product) {
        logger.info(chalk.dim("Note: --product resolves the slug to a product id at create time."));
      }
      logger.info(
        chalk.dim(
          "Note: the source name + slug are resolved from the channel feed at create time.",
        ),
      );
    }
    return;
  }

  // The video endpoint takes a typed `productId` (not a slug), so resolve a
  // `--product <slug>` client-side, matching the slug UX of `create`/`create-appstore`.
  let productId: string | undefined;
  if (opts.product) {
    let prod;
    try {
      prod = await findProduct(opts.product);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(chalk.red(`Failed to resolve --product "${opts.product}": ${msg}`));
      process.exit(1);
    }
    if (!prod) {
      logger.error(chalk.red(`Product not found: "${opts.product}"`));
      process.exit(1);
    }
    productId = prod.id;
  }

  let result;
  try {
    result = await createVideoSource({ url: trimmed, orgSlug, orgId, productId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(chalk.red(`Failed to create video source: ${msg}`));
    process.exit(1);
  }

  if (opts.json) {
    await writeJson(result);
    return;
  }

  const { source, releaseCount, status } = result;
  const { provider, channel } = videoMetaFromSource(source.metadata);
  const tag = provider ? chalk.dim(`[${provider}]`) : "";
  const channelLabel = channel ? ` — ${channel}` : "";
  const releaseLabel = `${releaseCount} release${releaseCount === 1 ? "" : "s"}`;
  if (status === "existing") {
    logger.info(
      chalk.yellow(
        `Video source already indexed: ${source.name} (${source.slug}) ${tag}${channelLabel} — ${releaseLabel}`,
      ),
    );
  } else {
    logger.info(
      chalk.green(
        `Video source created: ${source.name} (${source.slug}) ${tag}${channelLabel} — ${releaseLabel} indexed`,
      ),
    );
  }
}

export function registerCreateVideoCommand(program: Command) {
  program
    .command("create-video")
    .description(
      "Create a video source from a YouTube channel/playlist (resolves the feed, backfills current videos as releases)",
    )
    .argument("<channel-or-playlist-url>", "YouTube channel or playlist URL")
    .option("--org <slug>", "Organization slug or org_ id (required — must already exist)")
    .option("--product <slug>", "Existing product slug to attach the source to")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show the request that would be sent without creating")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source create-video https://www.youtube.com/@AnthropicAI --org anthropic
  releases admin source create-video https://www.youtube.com/playlist?list=PLf2m23nhTg1P --org anthropic --product claude
  releases admin source create-video https://www.youtube.com/@AnthropicAI --org anthropic --dry-run

Notes:
  - The org is required and must already exist — unlike create-appstore, no org
    is derived from the channel. Backfilled videos are description-only and run
    through the marketing-filtered ingest. The verb is idempotent on the
    resolved feed URL; re-running reports the existing source.
  - Do not use generic 'source create' for a YouTube URL — it builds a feed
    source that drops the video descriptions (empty release bodies). 'create'
    rejects YouTube URLs with a pointer here.`,
    )
    .action(createVideoAction);
}
