import { Command } from "commander";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { releases } from "@buildinternet/releases-core/schema";
import { insertMediaAssets, type MediaAssetInput } from "../../db/queries.js";
import { isRemoteMode } from "../../lib/mode.js";
import * as apiClient from "../../api/client.js";
import { sql, and, isNotNull } from "drizzle-orm";
import { logger } from "@buildinternet/releases-lib/logger";
import { extractFilename, type MediaRef } from "../../lib/media.js";

// Reverse mapping: file extension → content type
const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
};

/**
 * Parse an r2Key like `sources/<slug>/<hash16>.<ext>` to extract the
 * content hash and file extension.
 */
function parseR2Key(r2Key: string): { contentHash: string; ext: string } | null {
  // e.g. "sources/my-source/abcdef0123456789.png"
  const match = r2Key.match(/\/([a-f0-9]{16})\.(\w+)$/);
  if (!match) return null;
  return { contentHash: match[1], ext: match[2] };
}

interface BackfillRelease {
  id: string;
  sourceId: string;
  media: string;
}

/**
 * Fetch all releases with non-empty media JSON.
 * Supports both local and remote mode.
 */
async function fetchReleasesWithMedia(): Promise<BackfillRelease[]> {
  if (isRemoteMode()) {
    // Remote mode: use the API client to query releases with media
    return apiClient.queryReleasesWithMedia();
  }

  const db = getDb();
  const rows = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      media: releases.media,
    })
    .from(releases)
    .where(
      and(
        isNotNull(releases.media),
        sql`${releases.media} != '[]'`,
        sql`${releases.media} != ''`,
      )
    );

  return rows.filter((r): r is BackfillRelease => r.media !== null);
}

export function registerMediaCommand(program: Command) {
  const media = program
    .command("media")
    .description("Manage media assets");

  media
    .command("backfill")
    .description("Register existing media references from release content into the media asset index")
    .option("--dry-run", "Show what would be registered without writing")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin content media backfill
  releases admin content media backfill --dry-run
  releases admin content media backfill --json`)
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      logger.info("Scanning releases for media with R2 keys...");

      const releasesWithMedia = await fetchReleasesWithMedia();
      logger.info(`Found ${releasesWithMedia.length} release(s) with media JSON`);

      const assets: MediaAssetInput[] = [];
      let skipped = 0;

      for (const rel of releasesWithMedia) {
        let mediaRefs: MediaRef[];
        try {
          mediaRefs = JSON.parse(rel.media);
        } catch {
          logger.warn(`Skipping release ${rel.id}: invalid media JSON`);
          skipped++;
          continue;
        }

        if (!Array.isArray(mediaRefs)) {
          logger.warn(`Skipping release ${rel.id}: media is not an array`);
          skipped++;
          continue;
        }

        for (const ref of mediaRefs) {
          if (!ref.r2Key) continue;

          const parsed = parseR2Key(ref.r2Key);
          if (!parsed) {
            logger.warn(`Skipping media ref with unparseable r2Key: ${ref.r2Key}`);
            skipped++;
            continue;
          }

          const contentType = EXT_CONTENT_TYPE[parsed.ext] ?? "application/octet-stream";

          assets.push({
            r2Key: ref.r2Key,
            sourceUrl: ref.url,
            sourceFilename: extractFilename(ref.url),
            contentType,
            contentHash: parsed.contentHash,
            byteSize: 0, // unknown for backfilled entries
            sourceId: rel.sourceId,
            releaseId: rel.id,
          });
        }
      }

      logger.info(`Found ${assets.length} media asset(s) with R2 keys to register`);

      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({
            dryRun: true,
            releasesScanned: releasesWithMedia.length,
            assetsFound: assets.length,
            skipped,
            assets: assets.map((a) => ({
              r2Key: a.r2Key,
              sourceUrl: a.sourceUrl,
              contentType: a.contentType,
              releaseId: a.releaseId,
            })),
          }, null, 2));
        } else {
          console.log(chalk.yellow(`[dry-run] Would register ${assets.length} media asset(s)`));
          console.log(`  Releases scanned: ${releasesWithMedia.length}`);
          console.log(`  Skipped: ${skipped}`);
          for (const a of assets.slice(0, 20)) {
            console.log(`  ${chalk.dim(a.r2Key)}  ${a.contentType}`);
          }
          if (assets.length > 20) {
            console.log(chalk.dim(`  ... and ${assets.length - 20} more`));
          }
        }
        return;
      }

      if (assets.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ releasesScanned: releasesWithMedia.length, registered: 0, skipped }, null, 2));
        } else {
          console.log(chalk.yellow("No media assets with R2 keys found to register."));
        }
        return;
      }

      const inserted = await insertMediaAssets(assets);

      if (opts.json) {
        console.log(JSON.stringify({
          releasesScanned: releasesWithMedia.length,
          assetsFound: assets.length,
          registered: inserted,
          duplicatesSkipped: assets.length - inserted,
          skipped,
        }, null, 2));
      } else {
        console.log(chalk.green(`Registered ${inserted} media asset(s).`));
        if (assets.length - inserted > 0) {
          console.log(chalk.dim(`  ${assets.length - inserted} duplicate(s) already existed.`));
        }
        console.log(`  Releases scanned: ${releasesWithMedia.length}`);
        if (skipped > 0) {
          console.log(`  Skipped: ${skipped}`);
        }
      }
    });
}
