import { Command } from "commander";
import chalk from "chalk";
import type { Source } from "../../db/schema.js";
import type { FetchOptions } from "../../adapters/types.js";
import { getSourceMeta, updateSourceMeta } from "../../adapters/feed.js";
import { detectChangelogUrl } from "../../adapters/github.js";
import { getAdapter, contentHash } from "../../adapters/resolve.js";
import {
  findSourceBySlug, listAllSources, listFetchableSources,
  updateSource, deleteReleasesForSource, insertReleases, insertFetchLog,
} from "../../db/queries.js";
import { logger } from "../../lib/logger.js";
import { elapsedFormatted, daysAgoIso } from "../../lib/dates.js";
import { isRemoteMode } from "../../lib/mode.js";
import * as apiClient from "../../api/client.js";

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
    .option("--retry-errors", "Only fetch sources whose last fetch was an error")
    .option("--concurrency <n>", "Number of sources to fetch in parallel (default: 1)", "1")
    .addHelpText("after", `
Examples:
  released fetch                          Fetch all sources
  released fetch my-source                Fetch a single source
  released fetch --stale 6                Fetch sources not updated in 6+ hours
  released fetch --unfetched              Fetch sources never fetched before
  released fetch --retry-errors           Retry sources that errored last time
  released fetch my-source --dry-run      Preview without writing to DB
  released fetch my-source --force        Delete and re-fetch all releases
  released fetch --concurrency 5          Fetch 5 sources in parallel
  released fetch --json                   Output results as JSON`)
    .action(async (slugArg: string | undefined, opts: {
      source?: string; json?: boolean; since?: string; max?: string; all?: boolean;
      crawl?: boolean; crawlPattern?: string; dryRun?: boolean; force?: boolean; full?: boolean;
      unfetched?: boolean; stale?: string; retryErrors?: boolean; concurrency?: string;
    }) => {
      // Positional arg takes precedence over --source option
      const slug = slugArg ?? opts.source;
      const concurrency = Math.max(1, parseInt(opts.concurrency ?? "1", 10));

      const fetchResults: Array<{ source: string; newReleases: number; error?: string }> = [];
      let targetSources: Source[];

      if (slug) {
        const found = await findSourceBySlug(slug);
        if (!found) {
          console.error(chalk.red(`Source not found: ${slug}`));
          process.exit(1);
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
          console.log(chalk.bold(`Fetching ${targetSources.length} unfetched source${targetSources.length > 1 ? "s" : ""} (concurrency: ${concurrency})\n`));
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
          console.log(chalk.bold(`Fetching ${targetSources.length} stale source${targetSources.length > 1 ? "s" : ""} (concurrency: ${concurrency})\n`));
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
          console.log(chalk.bold(`Retrying ${targetSources.length} errored source${targetSources.length > 1 ? "s" : ""} (concurrency: ${concurrency})\n`));
        }
      } else {
        targetSources = await listAllSources();
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.yellow("No sources configured. Use `released add` to add one."));
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
        }).catch(() => {});
      }

      function progressSession(logLine?: string) {
        if (!isRemoteMode()) return;
        const now = Date.now();
        // Always send if there's a log line, otherwise throttle
        if (!logLine && now - lastProgressAt < PROGRESS_INTERVAL_MS && sessionSourcesFetched < targetSources.length) return;
        lastProgressAt = now;
        apiClient.postStatusEvent({
          type: "session:progress",
          sessionId,
          step: "fetching",
          totalSources: targetSources.length,
          sourcesFetched: sessionSourcesFetched,
          releasesFound: sessionReleasesFound,
          releasesInserted: sessionReleasesInserted,
          ...(logLine ? { logLine, currentAction: logLine } : {}),
        }).catch(() => {});
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
      const showProgress = !opts.json && total > 1 && concurrency > 1;
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
        const current = lastSourceName ? ` ${chalk.cyan(lastSourceName)}` : "";
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
                console.log(`  ${version}${raw.title}  ${date}`);
                if (raw.url) console.log(`    ${chalk.dim(raw.url)}`);
              }
            }
            return;
          }

          const rows = rawReleases.map((raw) => ({
            sourceId: source.id,
            version: raw.version ?? null,
            title: raw.title,
            content: raw.content,
            url: raw.url ?? null,
            contentHash: contentHash(raw),
            publishedAt: raw.publishedAt?.toISOString() ?? null,
          }));

          const inserted = await insertReleases(source, rows);
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

      await startSession();

      // Run with concurrency pool
      if (concurrency <= 1) {
        for (const source of targetSources) {
          if (stopping) break;
          await fetchOne(source);
        }
      } else {
        const queue = [...targetSources];
        const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          while (queue.length > 0 && !stopping) {
            const source = queue.shift()!;
            await fetchOne(source);
          }
        });
        await Promise.all(workers);
      }

      process.removeListener("SIGINT", onSigint);

      const fetchErrors = fetchResults.filter((r) => r.error);
      if (fetchErrors.length === fetchResults.length && fetchResults.length > 0) {
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
            console.log(`    ${chalk.dim("•")} ${f.source}: ${chalk.red(f.error!)}`);
          }
        }
      }
    });
}
