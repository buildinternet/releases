import { Command } from "commander";
import chalk from "chalk";
import type { Source } from "../../db/schema.js";
import { sourceNotFound } from "../suggest.js";
import type { FetchOptions } from "../../adapters/types.js";
import { getSourceMeta, updateSourceMeta } from "../../adapters/feed.js";
import { detectChangelogUrl } from "../../adapters/github.js";
import { getAdapter, contentHash } from "../../adapters/resolve.js";
import {
  findSourceBySlug, listAllSources, listFetchableSources, listSourcesWithChanges,
  updateSource, deleteReleasesForSource, insertReleases, insertFetchLog,
  upsertSummary, getMonthlySummary, getRecentReleases, getOrgById, getSourcesByOrg,
  insertMediaAssets, clearChangeDetected,
  getKnowledgePageForOrg, upsertKnowledgePage,
} from "../../db/queries.js";
import { generateSummary, DEFAULT_WINDOW_DAYS } from "../../ai/summarize.js";
import { isSummarizationEnabled } from "../../ai/summarize-check.js";
import { generateKnowledgePage } from "../../ai/knowledge.js";
import { logger } from "../../lib/logger.js";
import { processMediaForR2, filterJunkMedia, type MediaRef, type MediaUploadProgress } from "../../lib/media.js";
import { config } from "../../lib/config.js";
import { enrichReleases } from "../../adapters/enrich.js";
import { elapsedFormatted, daysAgoIso } from "../../lib/dates.js";
import { isRemoteMode } from "../../lib/mode.js";
import { stripAnsi } from "../../lib/sanitize.js";
import * as apiClient from "../../api/client.js";

const REMOTE_MAX_CONCURRENCY = 5;
const REMOTE_DEFAULT_CONCURRENCY = 3;
const CANCEL_MSG = "Session cancelled remotely — stopping...";

export function registerFetchCommand(program: Command) {
  program
    .command("fetch")
    .description("Fetch releases from configured sources")
    .argument("[slug]", "Fetch a specific source by slug, or all sources if omitted")
    .option("--source <slug>", "Source slug (alternative to positional argument)")
    .option("--json", "Output as JSON")
    .option("--since <date>", "Only fetch releases after this date (ISO 8601 or YYYY-MM-DD)")
    .option("--max <n>", "Maximum number of releases to fetch per source (default: 200)")
    .option("--all", "Fetch all releases with no limits (overrides --max default)")
    .option("--crawl", "Enable crawl mode for multi-page changelogs (scrape sources only, persists)")
    .option("--no-crawl", "One-off override to skip crawl mode for this invocation")
    .option("--crawl-pattern <pattern>", "URL pattern to scope crawl (e.g. https://example.com/changelog/*)")
    .option("--dry-run", "Run the adapter but skip DB inserts — show what would be fetched")
    .option("--force", "Delete existing releases for the source before fetching (clean re-fetch)")
    .option("--full", "Force full re-parse of all content (bypass incremental optimization)")
    .option("--unfetched", "Only fetch sources that have never been fetched")
    .option("--stale <hours>", "Only fetch sources older than N hours, respecting backoff")
    .option("--changed", "Only fetch sources where poll detected upstream changes")
    .option("--retry-errors", "Only fetch sources whose last fetch was an error")
    .option("--no-summarize", "Skip summary generation after fetching")
    .option("--concurrency <n>", "Number of sources to fetch in parallel (default: 1)", "1")
    .addHelpText("after", `
Examples:
  releases fetch                          Fetch all sources
  releases fetch my-source                Fetch a single source
  releases fetch --stale 6                Fetch sources not updated in 6+ hours
  releases fetch --unfetched              Fetch sources never fetched before
  releases fetch --changed                Fetch sources where poll detected changes
  releases fetch --retry-errors           Retry sources that errored last time
  releases fetch my-source --dry-run      Preview without writing to DB
  releases fetch my-source --force        Delete and re-fetch all releases
  releases fetch --concurrency 5          Fetch 5 sources in parallel
  releases fetch --json                   Output results as JSON`)
    .action(async (slugArg: string | undefined, opts: {
      source?: string; json?: boolean; since?: string; max?: string; all?: boolean;
      crawl?: boolean; crawlPattern?: string; dryRun?: boolean; force?: boolean; full?: boolean;
      unfetched?: boolean; stale?: string; changed?: boolean; retryErrors?: boolean; concurrency?: string;
      summarize?: boolean;
    }) => {
      // Positional arg takes precedence over --source option
      const slug = slugArg ?? opts.source;
      const concurrency = Math.max(1, parseInt(opts.concurrency ?? "1", 10));

      let effectiveConcurrency = concurrency;
      if (isRemoteMode()) {
        if (concurrency === 1 && !opts.concurrency) {
          effectiveConcurrency = REMOTE_DEFAULT_CONCURRENCY;
        } else if (concurrency > REMOTE_MAX_CONCURRENCY) {
          effectiveConcurrency = REMOTE_MAX_CONCURRENCY;
          if (!opts.json) {
            logger.warn(`Remote concurrency capped at ${REMOTE_MAX_CONCURRENCY} (requested ${concurrency}).`);
          }
        }
      }

      const fetchResults: Array<{ source: string; newReleases: number; error?: string }> = [];
      let targetSources: Source[];

      if (slug) {
        const found = await findSourceBySlug(slug);
        if (!found) {
          return sourceNotFound(slug);
        }
        targetSources = [found];
      } else if (opts.unfetched) {
        targetSources = await listFetchableSources({ mode: "unfetched" });
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.green("All sources have been fetched."));
          }
          return;
        }
        if (!opts.json) {
          console.log(chalk.bold(`Fetching ${targetSources.length} unfetched source${targetSources.length > 1 ? "s" : ""} (concurrency: ${effectiveConcurrency})\n`));
        }
        // Default to 30 days of history for unfetched sources unless overridden
        if (!opts.since && !opts.all) {
          opts.since = daysAgoIso(30).split("T")[0];
        }
      } else if (opts.stale) {
        const hours = parseInt(opts.stale, 10);
        targetSources = await listFetchableSources({ mode: "stale", staleHours: hours });
        // Sort: normal priority first, then low; within each, oldest fetched first
        targetSources.sort((a, b) => {
          if (a.fetchPriority !== b.fetchPriority) return a.fetchPriority === 'normal' ? -1 : 1;
          return (a.lastFetchedAt ?? '').localeCompare(b.lastFetchedAt ?? '');
        });
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.green("No stale sources found."));
          }
          return;
        }
        if (!opts.json) {
          console.log(chalk.bold(`Fetching ${targetSources.length} stale source${targetSources.length > 1 ? "s" : ""} (concurrency: ${effectiveConcurrency})\n`));
        }
      } else if (opts.changed) {
        targetSources = await listSourcesWithChanges();
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.green("No sources with detected changes."));
          }
          return;
        }
        if (!opts.json) {
          console.log(chalk.bold(`Fetching ${targetSources.length} changed source${targetSources.length > 1 ? "s" : ""} (concurrency: ${effectiveConcurrency})\n`));
        }
      } else if (opts.retryErrors) {
        targetSources = await listFetchableSources({ mode: "retry_errors" });
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.green("No errored sources found."));
          }
          return;
        }
        if (!opts.json) {
          console.log(chalk.bold(`Retrying ${targetSources.length} errored source${targetSources.length > 1 ? "s" : ""} (concurrency: ${effectiveConcurrency})\n`));
        }
      } else {
        if (isRemoteMode()) {
          console.error(chalk.red("Remote fetch requires a filter to prevent expensive bulk operations."));
          console.error(chalk.gray("Use one of: a source slug, --stale <hours>, --unfetched, --changed, or --retry-errors."));
          process.exit(1);
        }
        targetSources = await listAllSources();
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.yellow("No sources configured. Use `releases add` to add one."));
          }
          return;
        }
      }

      // Build fetch options with defaults
      const DEFAULT_MAX_RELEASES = 200;
      const fetchOptions: FetchOptions = {};
      if (!opts.all) {
        if (opts.since) {
          fetchOptions.since = new Date(opts.since);
        }
        if (opts.max) {
          fetchOptions.maxEntries = parseInt(opts.max, 10);
        } else {
          fetchOptions.maxEntries = DEFAULT_MAX_RELEASES;
        }
      }

      // ── Session tracking for remote mode ──
      const sessionId = crypto.randomUUID();
      let sessionCompany = "";
      let sessionReleasesFound = 0;
      let sessionReleasesInserted = 0;
      let sessionSourcesFetched = 0;
      let lastProgressAt = 0;
      const PROGRESS_INTERVAL_MS = 2000;

      async function startSession() {
        if (!isRemoteMode() || targetSources.length === 0) return;
        sessionCompany = targetSources.length === 1
          ? targetSources[0].name
          : `${targetSources.length} sources`;
        await apiClient.postStatusEvent({
          type: "session:start",
          sessionId,
          company: sessionCompany,
          sessionType: "update",
          activeSources: targetSources.map((s) => s.slug),
        }).catch(() => {});
      }

      async function progressSession(logLine?: string) {
        if (!isRemoteMode()) return;
        const now = Date.now();
        // Always send if there's a log line, otherwise throttle
        if (!logLine && now - lastProgressAt < PROGRESS_INTERVAL_MS && sessionSourcesFetched < targetSources.length) return;
        lastProgressAt = now;
        const remainingSlugs = targetSources.slice(sessionSourcesFetched).map((s) => s.slug);
        try {
          const result = await apiClient.postStatusEvent({
            type: "session:progress",
            sessionId,
            step: "fetching",
            totalSources: targetSources.length,
            sourcesFetched: sessionSourcesFetched,
            releasesFound: sessionReleasesFound,
            releasesInserted: sessionReleasesInserted,
            activeSources: remainingSlugs,
            ...(logLine ? { logLine, currentAction: logLine } : {}),
          });
          if (result.cancelRequested && !stopping) {
            stopping = true;
            if (!opts.json) {
              process.stderr.write(`\n${chalk.yellow(CANCEL_MSG)}\n`);
            }
          }
        } catch {
          // Non-critical — don't fail the fetch
        }
      }

      let cancelCheckedAt = 0;
      const CANCEL_CHECK_INTERVAL_MS = 30000; // Fallback only — primary cancel detection is piggybacked on progress events

      async function checkCancelled(): Promise<boolean> {
        if (!isRemoteMode()) return false;
        const now = Date.now();
        if (now - cancelCheckedAt < CANCEL_CHECK_INTERVAL_MS) return false;
        cancelCheckedAt = now;
        try {
          const session = await apiClient.getSession(sessionId);
          return session?.cancelRequested === true;
        } catch {
          return false;
        }
      }

      async function endSession(error?: string) {
        if (!isRemoteMode()) return;
        await apiClient.postStatusEvent({
          type: error ? "session:error" : "session:complete",
          sessionId,
          ...(error ? { error } : {}),
        }).catch(() => {});
      }

      let completed = 0;
      let active = 0;
      let totalInserted = 0;
      let stopping = false;
      const total = targetSources.length;
      const fetchStartTime = performance.now();
      const orgsNeedingKnowledgeUpdate = new Set<string>();
      const showProgress = !opts.json && total > 1 && effectiveConcurrency > 1;
      const showSummary = !opts.json && total > 1;

      function onSigint() {
        if (stopping) return;
        stopping = true;
        if (!opts.json) {
          process.stderr.write(`\n${chalk.yellow(`Stopping gracefully — waiting for ${active} active fetch(es) to finish...`)}\n`);
        }
      }
      process.on("SIGINT", onSigint);

      let lastSourceName = "";

      function printProgress(sourceName?: string) {
        if (!showProgress) return;
        if (sourceName) lastSourceName = sourceName;
        const pct = Math.round((completed / total) * 100);
        const elapsed = elapsedFormatted(fetchStartTime);
        const bar = chalk.gray(`[${completed}/${total}]`);
        const errCount = fetchResults.filter((r) => r.error).length;
        const activeStr = active > 0 ? chalk.gray(` (${active} active)`) : "";
        const errStr = errCount > 0 ? chalk.red(` ${errCount} failed`) : "";
        const insertStr = totalInserted > 0 ? chalk.green(` ${totalInserted} new`) : "";
        const current = lastSourceName ? ` ${chalk.cyan(stripAnsi(lastSourceName))}` : "";
        const time = chalk.gray(` ${elapsed}`);
        process.stderr.write(`\r${bar} ${pct}%${current}${activeStr}${insertStr}${errStr}${time}${"".padEnd(20)}`);
      }

      async function fetchOne(source: Source): Promise<void> {
        const adapter = getAdapter(source.type);
        if (!adapter) {
          completed++;
          return;
        }

        let sourceModified = false;

        // Handle --crawl flag: persist on scrape sources, warn on others
        if (opts.crawl === true && source.type !== "scrape") {
          if (!opts.json) {
            logger.warn(`--crawl is only supported for scrape sources, skipping for ${source.name} (${source.type})`);
          }
        }

        if (opts.crawl === true && source.type === "scrape" && !opts.dryRun) {
          const pattern = opts.crawlPattern ?? `${source.url.replace(/\/$/, "")}/**`;
          await updateSourceMeta(source, {
            crawlEnabled: true,
            crawlPattern: pattern,
          });
          await updateSource(source, { lastContentHash: null });
          sourceModified = true;
          if (!opts.json) {
            logger.info(`Crawl mode enabled for ${source.name} (pattern: ${pattern})`);
          }
        }

        // --force: delete existing releases for a clean re-fetch
        if (opts.force && !opts.dryRun) {
          const deletedCount = await deleteReleasesForSource(source);
          if (!opts.json && deletedCount > 0) {
            logger.info(`Cleared ${deletedCount} existing release(s) for ${source.name}`);
          }
          await updateSource(source, { lastContentHash: null });
          await updateSourceMeta(source, { lastCrawlAt: undefined });
          sourceModified = true;
        }

        // Reload source from DB if we modified metadata/columns so the adapter sees fresh data
        if (sourceModified) {
          const reloaded = await findSourceBySlug(source.slug);
          if (reloaded) source = reloaded;
        }

        // Build per-source fetch options (clone to avoid mutation across concurrent fetches)
        const sourceFetchOptions: FetchOptions = {
          ...fetchOptions,
          crawl: opts.crawl,
          full: opts.full,
          dryRun: opts.dryRun,
          onParseProgress: (completed, total) => {
            progressSession(`${source.name}: parsing chunk ${completed}/${total}`);
          },
        };

        if (!opts.json && !showProgress) {
          const limits = [];
          if (sourceFetchOptions.since) limits.push(`since ${sourceFetchOptions.since.toISOString().split("T")[0]}`);
          if (sourceFetchOptions.maxEntries) limits.push(`max ${sourceFetchOptions.maxEntries}`);
          const limitStr = limits.length > 0 ? ` (${limits.join(", ")})` : "";
          logger.info(`Fetching releases from ${chalk.cyan(source.name)}${limitStr}...`);
        }

        active++;
        printProgress(source.name);
        progressSession(`Fetching ${source.name}...`);
        const startTime = performance.now();

        let rawContent: string | undefined;
        try {
          const result = await adapter.fetch(source, sourceFetchOptions);
          const rawReleases = result.releases;
          rawContent = result.rawContent;

          if (rawReleases.length === 0) {
            if (!opts.json && !showProgress) {
              const msg = source.type === "scrape"
                ? `No changes detected for ${source.name}`
                : `No releases found for ${source.name}`;
              console.log(chalk.yellow(`${msg} ${chalk.dim(`(${elapsedFormatted(startTime)})`)}`));
            }
            if (!opts.dryRun) {
              await insertFetchLog({
                sourceId: source.id,
                releasesFound: 0,
                releasesInserted: 0,
                durationMs: Math.round(performance.now() - startTime),
                status: "no_change",
                rawContent: rawContent ?? null,
              });

              // Update backoff counters for no_change
              const newNoChange = (source.consecutiveNoChange ?? 0) + 1;
              const backoffHours = Math.min(Math.pow(2, newNoChange - 1), 48);
              const nextFetch = new Date(Date.now() + backoffHours * 3600_000).toISOString();
              await updateSource(source, {
                consecutiveNoChange: newNoChange,
                consecutiveErrors: 0,
                nextFetchAfter: nextFetch,
              });
              await clearChangeDetected(source);
            }
            fetchResults.push({ source: source.name, newReleases: 0 });
            progressSession(`${source.name}: no changes`);
            return;
          }

          // ── Dry-run: show results without writing releases to DB ──
          if (opts.dryRun) {
            fetchResults.push({ source: source.name, newReleases: rawReleases.length });
            totalInserted += rawReleases.length;
            sessionReleasesFound += rawReleases.length;

            // Log to fetch_log with dry_run status so stats shows it correctly
            await insertFetchLog({
              sourceId: source.id,
              releasesFound: rawReleases.length,
              releasesInserted: 0,
              durationMs: Math.round(performance.now() - startTime),
              status: "dry_run",
              rawContent: rawContent ?? null,
            });

            if (!opts.json) {
              console.log(chalk.bold(`\n${source.name}: ${rawReleases.length} release(s) found ${chalk.dim(`(${elapsedFormatted(startTime)})`)}\n`));
              for (const raw of rawReleases) {
                const date = raw.publishedAt ? chalk.gray(raw.publishedAt.toISOString().split("T")[0]) : chalk.gray("no date");
                const version = raw.version ? chalk.cyan(`[${raw.version}] `) : "";
                console.log(`  ${version}${stripAnsi(raw.title)}  ${date}`);
                if (raw.url) console.log(`    ${chalk.dim(stripAnsi(raw.url))}`);
              }
            }
            return;
          }

          // Filter junk media (avatars, logos, tracking pixels) before storing
          let totalDropped = 0;
          for (const raw of rawReleases) {
            if (raw.media && raw.media.length > 0) {
              const filtered = filterJunkMedia(raw.media, raw.content);
              raw.media = filtered.media;
              raw.content = filtered.content;
              totalDropped += filtered.dropped.length;
              for (const d of filtered.dropped) {
                logger.debug(`Filtered junk media: ${d.reason} — ${d.url}`);
              }
            }
          }
          if (totalDropped > 0) {
            logger.info(`Filtered ${totalDropped} junk media item(s) for ${source.slug}`);
          }

          const rows = rawReleases.map((raw) => ({
            sourceId: source.id,
            version: raw.version ?? null,
            title: raw.title,
            content: raw.content,
            url: raw.url ?? null,
            contentHash: contentHash(raw),
            publishedAt: raw.publishedAt?.toISOString() ?? null,
            media: JSON.stringify(raw.media ?? []),
          }));

          // Upload media to R2 and rewrite URLs (remote mode only)
          const apiUrl = config.apiUrl();
          let pendingAssets: Array<import("../../lib/media.js").UploadResult & { sourceId: string }> = [];
          if (apiUrl) {
            const parsed = rows.map((row) => {
              if (!row.media || row.media === "[]") return [];
              try { return JSON.parse(row.media) as MediaRef[]; } catch { return []; }
            });
            const allMedia = parsed.flat().filter(m => m.url);
            if (allMedia.length > 0) {
              const imageCount = allMedia.filter(m => m.type === "image" || m.type === "gif").length;
              const videoCount = allMedia.filter(m => m.type === "video").length;
              const releasesWithMedia = parsed.filter(m => m.length > 0).length;
              progressSession(
                `${source.name}: found ${imageCount} image${imageCount !== 1 ? "s" : ""}, ${videoCount} video${videoCount !== 1 ? "s" : ""} in ${releasesWithMedia} release${releasesWithMedia !== 1 ? "s" : ""}`,
              );

              const uploadResults = await processMediaForR2(allMedia, source.slug, (progress: MediaUploadProgress) => {
                progressSession(
                  `${source.name}: uploading ${progress.uploaded}/${progress.total} images to R2...`,
                );
              });

              // Emit completion summary
              const totalBytes = uploadResults.reduce((sum, r) => sum + r.byteSize, 0);
              const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
              const failedCount = allMedia.length - uploadResults.length;
              if (uploadResults.length > 0) {
                progressSession(
                  `${source.name}: uploaded ${uploadResults.length} image${uploadResults.length !== 1 ? "s" : ""} (${totalMB} MB) to R2`,
                );
              }
              if (failedCount > 0) {
                progressSession(
                  `${source.name}: failed to upload ${failedCount} image${failedCount !== 1 ? "s" : ""}`,
                );
              }

              for (let i = 0; i < rows.length; i++) {
                const media = parsed[i];
                if (media.length === 0) continue;
                let content = rows[i].content;
                for (const m of media) {
                  if (m.r2Key) content = content.replaceAll(m.url, `${apiUrl}/v1/media/${m.r2Key}`);
                }
                rows[i].content = content;
                rows[i].media = JSON.stringify(media);
              }
              pendingAssets = uploadResults.map((r) => ({ ...r, sourceId: source.id }));
            }
          }

          // Insert releases and register media assets concurrently
          const [inserted] = await Promise.all([
            insertReleases(source, rows),
            pendingAssets.length > 0
              ? insertMediaAssets(pendingAssets).then((n) => {
                  logger.info(`Registered ${n} media asset(s) for ${source.slug}`);
                })
              : Promise.resolve(),
          ]);
          totalInserted += inserted;

          // Detect changelog URL for GitHub sources (one-time)
          if (source.type === "github") {
            const meta = getSourceMeta(source);
            if (!meta.changelogUrl && !meta.changelogDetectedAt) {
              const changelogUrl = await detectChangelogUrl(source);
              await updateSourceMeta(source, {
                changelogUrl: changelogUrl ?? undefined,
                changelogDetectedAt: new Date().toISOString(),
              });
            }
          }

          fetchResults.push({ source: source.name, newReleases: inserted });
          sessionReleasesFound += rawReleases.length;
          sessionReleasesInserted += inserted;
          progressSession(`${source.name}: ${inserted} new releases (${elapsedFormatted(startTime)})`);

          await insertFetchLog({
            sourceId: source.id,
            releasesFound: rawReleases.length,
            releasesInserted: inserted,
            durationMs: Math.round(performance.now() - startTime),
            status: inserted > 0 ? "success" : "no_change",
            rawContent: rawContent ?? null,
          });

          await updateSource(source, {
            lastFetchedAt: new Date().toISOString(),
            consecutiveNoChange: 0,
            consecutiveErrors: 0,
            nextFetchAfter: null,
          });
          await clearChangeDetected(source);

          // Generate release summary if enabled
          if (inserted > 0 && opts.summarize !== false) {
            try {
              const org = source.orgId ? await getOrgById(source.orgId) : null;
              const summarizeEnabled = await isSummarizationEnabled(source, org);
              if (summarizeEnabled) {
                const cutoff = daysAgoIso(DEFAULT_WINDOW_DAYS);
                const recentReleases = await getRecentReleases(source.id, cutoff, source.slug);
                const orgDescription = org?.description || undefined;

                if (recentReleases.length > 0) {
                  // Rolling summary
                  const rolling = await generateSummary({
                    sourceName: source.name,
                    sourceSlug: source.slug,
                    releases: recentReleases,
                    windowDays: DEFAULT_WINDOW_DAYS,
                    type: "rolling",
                    orgDescription,
                  });
                  if (rolling) {
                    await upsertSummary({
                      sourceId: source.id,
                      orgId: source.orgId,
                      type: "rolling",
                      windowDays: DEFAULT_WINDOW_DAYS,
                      summary: rolling.summary,
                      releaseCount: rolling.releaseCount,
                      year: null,
                      month: null,
                    });
                  }

                  // Monthly summary — check if last month needs one
                  const now = new Date();
                  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                  const lmYear = lastMonth.getFullYear();
                  const lmMonth = lastMonth.getMonth() + 1; // 1-indexed

                  const existing = await getMonthlySummary(source.id, lmYear, lmMonth);
                  if (!existing) {
                    const monthStart = new Date(lmYear, lmMonth - 1, 1).toISOString();
                    const monthEnd = new Date(lmYear, lmMonth, 1).toISOString();
                    const monthlyReleases = recentReleases.filter(
                      (r) => r.publishedAt && r.publishedAt >= monthStart && r.publishedAt < monthEnd,
                    );
                    if (monthlyReleases.length > 0) {
                      const monthName = lastMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });
                      const monthly = await generateSummary({
                        sourceName: source.name,
                        sourceSlug: source.slug,
                        releases: monthlyReleases,
                        type: "monthly",
                        period: monthName,
                        orgDescription,
                      });
                      if (monthly) {
                        await upsertSummary({
                          sourceId: source.id,
                          orgId: source.orgId,
                          type: "monthly",
                          year: lmYear,
                          month: lmMonth,
                          summary: monthly.summary,
                          releaseCount: monthly.releaseCount,
                          windowDays: null,
                        });
                      }
                    }
                  }
                }
              }
            } catch (err) {
              // Summary generation is non-critical — log and continue
              logger.warn(`Summary generation failed for ${source.name}: ${err}`);
            }
          }

          // Auto-enrich if the source is flagged (e.g., summary-only feeds)
          if (inserted > 0 && !opts.dryRun) {
            const enrichMeta = getSourceMeta(source);
            if (enrichMeta.autoEnrich) {
              try {
                logger.info(`Auto-enriching ${inserted} new release(s) for ${source.slug}...`);
                const enrichResult = await enrichReleases({
                  sourceSlug: source.slug,
                  limit: inserted,
                });
                if (enrichResult.enriched > 0) {
                  logger.info(`Auto-enriched ${enrichResult.enriched} release(s) for ${source.slug}`);
                }
              } catch (err) {
                logger.warn(`Auto-enrich failed for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          // Defer knowledge page regeneration until after all sources are processed
          if (inserted > 0 && source.orgId && opts.summarize !== false) {
            orgsNeedingKnowledgeUpdate.add(source.orgId);
          }

          if (!opts.json && !showProgress) {
            console.log(
              chalk.green(`Fetched ${inserted} new releases from ${source.name} ${chalk.dim(`(${elapsedFormatted(startTime)})`)}`),
            );
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          fetchResults.push({ source: source.name, newReleases: 0, error: errMsg });
          progressSession(`${source.name}: error — ${errMsg.slice(0, 100)}`);

          await insertFetchLog({
            sourceId: source.id,
            releasesFound: 0,
            releasesInserted: 0,
            durationMs: Math.round(performance.now() - startTime),
            status: "error",
            error: errMsg,
            rawContent: rawContent ?? null,
          }).catch(() => {}); // don't fail the whole fetch if logging fails

          // Update error backoff counter
          if (!opts.dryRun) {
            const newErrors = (source.consecutiveErrors ?? 0) + 1;
            const errorBackoffHours = Math.min(Math.pow(2, newErrors - 1), 72);
            const nextFetchOnError = new Date(Date.now() + errorBackoffHours * 3600_000).toISOString();
            await updateSource(source, {
              consecutiveErrors: newErrors,
              nextFetchAfter: nextFetchOnError,
            }).catch(() => {});
          }

          if (!showProgress) {
            logger.error(`Failed to fetch from ${source.name} (${elapsedFormatted(startTime)}):`, err);
          }
        } finally {
          active--;
          completed++;
          printProgress();
          if (!opts.dryRun) {
            sessionSourcesFetched++;
            progressSession();
          }
        }
      }

      // ── Source-level duplicate detection (remote mode) ──
      if (isRemoteMode() && targetSources.length > 0) {
        try {
          const { slugs: activeSlugs, sessionMap } = await apiClient.getActiveSources();
          const targetSlugs = targetSources.map((s) => s.slug);
          const overlapping = targetSlugs.filter((s) => activeSlugs.includes(s));
          if (overlapping.length > 0) {
            const overlapSessionId = sessionMap[overlapping[0]];
            const sourceList = overlapping.length <= 3
              ? overlapping.map((s) => `"${s}"`).join(", ")
              : `${overlapping.length} sources`;
            console.error(chalk.red(`Source ${sourceList} already being fetched in session ${overlapSessionId.slice(0, 8)}.`));
            console.error(chalk.gray(`Use 'releases task cancel ${overlapSessionId.slice(0, 8)}' to stop it first.`));
            process.exit(1);
          }
        } catch {
          if (!opts.json) {
            logger.warn("Could not check for overlapping sessions — proceeding anyway.");
          }
        }
      }

      await startSession();

      // Run with concurrency pool
      if (effectiveConcurrency <= 1) {
        for (const source of targetSources) {
          if (stopping) break;
          if (await checkCancelled()) {
            stopping = true;
            if (!opts.json) {
              process.stderr.write(`\n${chalk.yellow(CANCEL_MSG)}\n`);
            }
            break;
          }
          await fetchOne(source);
        }
      } else {
        const queue = [...targetSources];
        const workers = Array.from({ length: Math.min(effectiveConcurrency, queue.length) }, async () => {
          while (queue.length > 0 && !stopping) {
            if (await checkCancelled()) {
              stopping = true;
              if (!opts.json) {
                process.stderr.write(`\n${chalk.yellow(CANCEL_MSG)}\n`);
              }
              break;
            }
            const source = queue.shift()!;
            await fetchOne(source);
          }
        });
        await Promise.all(workers);
      }

      process.removeListener("SIGINT", onSigint);

      // Regenerate knowledge pages for orgs that had new releases
      for (const orgId of orgsNeedingKnowledgeUpdate) {
        try {
          const org = await getOrgById(orgId);
          if (!org) continue;
          const cutoff = daysAgoIso(DEFAULT_WINDOW_DAYS);
          const orgSources = await getSourcesByOrg(org.id);
          const [releaseArrays, existingPage] = await Promise.all([
            Promise.all(orgSources.map((s) => getRecentReleases(s.id, cutoff, s.slug))),
            getKnowledgePageForOrg(org.id, org.slug),
          ]);
          const allOrgReleases = releaseArrays.flat()
            .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

          if (allOrgReleases.length === 0) continue;

          const result = await generateKnowledgePage({
            name: org.name,
            slug: org.slug,
            description: org.description || undefined,
            existingContent: existingPage?.content,
            newReleases: allOrgReleases.slice(0, 30),
            totalReleaseCount: allOrgReleases.length,
            sourceNames: orgSources.map((s) => s.name),
          });

          if (result) {
            const latestDate = allOrgReleases[0]?.publishedAt ?? null;
            await upsertKnowledgePage({
              scope: "org",
              orgId: org.id,
              content: result.content,
              releaseCount: result.releaseCount,
              lastContributingReleaseAt: latestDate,
            });
          }
        } catch (err) {
          logger.warn(`Knowledge page update failed for org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const fetchErrors = fetchResults.filter((r) => r.error);
      if (stopping && await checkCancelled().catch(() => false)) {
        await apiClient.postStatusEvent({
          type: "session:cancelled",
          sessionId,
        }).catch(() => {});
      } else if (fetchErrors.length === fetchResults.length && fetchResults.length > 0) {
        await endSession(`All ${fetchResults.length} sources failed`);
      } else {
        await endSession();
      }

      // Clear progress line
      if (showProgress) {
        process.stderr.write("\r" + "".padEnd(80) + "\r");
      }

      if (opts.json) {
        console.log(JSON.stringify(fetchResults, null, 2));
      } else if (showSummary) {
        const successful = fetchResults.filter((r) => !r.error);
        const failed = fetchResults.filter((r) => r.error);
        const withReleases = successful.filter((r) => r.newReleases > 0);

        const elapsed = elapsedFormatted(fetchStartTime);
        const label = stopping ? `Fetch stopped early: ${completed}/${total} sources` : `Fetch complete: ${total} sources`;
        console.log(chalk.bold(`\n${label}`) + chalk.gray(` (${elapsed})\n`));
        console.log(`  ${chalk.green(`${withReleases.length} with new releases`)} (${totalInserted} total)`);
        console.log(`  ${chalk.gray(`${successful.length - withReleases.length} unchanged`)}`);
        if (failed.length > 0) {
          console.log(`  ${chalk.red(`${failed.length} failed`)}`);
          for (const f of failed) {
            console.log(`    ${chalk.dim("•")} ${f.source}: ${chalk.red(stripAnsi(f.error!))}`);
          }
        }
      }
    });
}
