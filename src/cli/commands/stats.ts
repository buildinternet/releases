import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { sql, eq, gte, desc, count } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases, organizations, fetchLog } from "../../db/schema.js";
import { daysAgoIso, timeAgo } from "../../lib/dates.js";

export function registerStatsCommand(program: Command) {
  program
    .command("stats")
    .description("Show index statistics and recent fetch activity")
    .option("--json", "Output as JSON")
    .option("--days <n>", "Period for recent activity (default: 30)", "30")
    .action(async (opts: { json?: boolean; days?: string }) => {
      const db = getDb();
      const days = parseInt(opts.days ?? "30", 10);
      const cutoff = daysAgoIso(days);

      // ── Aggregate counts ─────────────────────────────────────
      const [orgCount] = await db.select({ n: count() }).from(organizations);
      const [sourceCount] = await db.select({ n: count() }).from(sources);
      const [releaseCount] = await db.select({ n: count() }).from(releases);
      const [recentReleaseCount] = await db
        .select({ n: count() })
        .from(releases)
        .where(gte(releases.publishedAt, cutoff));

      // Sources never fetched
      const [neverFetched] = await db
        .select({ n: count() })
        .from(sources)
        .where(sql`${sources.lastFetchedAt} IS NULL`);

      // Sources fetched within the period
      const [recentlyFetched] = await db
        .select({ n: count() })
        .from(sources)
        .where(gte(sources.lastFetchedAt, cutoff));

      // Stale sources (fetched, but not within the period)
      const staleCount = sourceCount.n - neverFetched.n - recentlyFetched.n;

      // ── Per-source release counts (top sources) ──────────────
      const perSource = await db
        .select({
          sourceName: sources.name,
          sourceSlug: sources.slug,
          sourceType: sources.type,
          orgName: organizations.name,
          lastFetchedAt: sources.lastFetchedAt,
          totalReleases: count(releases.id),
          recentReleases: sql<number>`SUM(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 ELSE 0 END)`,
        })
        .from(sources)
        .leftJoin(releases, eq(releases.sourceId, sources.id))
        .leftJoin(organizations, eq(sources.orgId, organizations.id))
        .groupBy(sources.id)
        .orderBy(desc(sql`SUM(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 ELSE 0 END)`));

      // ── Recent fetch activity ────────────────────────────────
      const recentFetches = await db
        .select({
          sourceName: sources.name,
          sourceSlug: sources.slug,
          orgName: organizations.name,
          releasesFound: fetchLog.releasesFound,
          releasesInserted: fetchLog.releasesInserted,
          totalReleases: sql<number>`(SELECT COUNT(*) FROM releases WHERE releases.source_id = ${sources.id})`,
          status: fetchLog.status,
          durationMs: fetchLog.durationMs,
          error: fetchLog.error,
          createdAt: fetchLog.createdAt,
        })
        .from(fetchLog)
        .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
        .leftJoin(organizations, eq(sources.orgId, organizations.id))
        .orderBy(desc(fetchLog.createdAt))
        .limit(20);

      // ── JSON output ──────────────────────────────────────────
      if (opts.json) {
        console.log(JSON.stringify({
          period: { days, cutoff },
          totals: {
            organizations: orgCount.n,
            sources: sourceCount.n,
            releases: releaseCount.n,
            releasesInPeriod: recentReleaseCount.n,
          },
          sourceHealth: {
            upToDate: recentlyFetched.n,
            stale: staleCount,
            neverFetched: neverFetched.n,
          },
          sources: perSource.map((s) => ({
            name: s.sourceName,
            slug: s.sourceSlug,
            type: s.sourceType,
            org: s.orgName,
            lastFetched: s.lastFetchedAt,
            totalReleases: s.totalReleases,
            recentReleases: s.recentReleases,
          })),
          recentActivity: recentFetches,
        }, null, 2));
        return;
      }

      // ── Human output ─────────────────────────────────────────
      console.log(chalk.bold("Overview\n"));
      console.log(`  Organizations:  ${orgCount.n}`);
      console.log(`  Sources:        ${sourceCount.n}`);
      console.log(`  Releases:       ${releaseCount.n}`);
      console.log(`  Last ${days} days:   ${recentReleaseCount.n} releases\n`);

      console.log(chalk.bold("Source Health\n"));
      console.log(`  ${chalk.green(`${recentlyFetched.n} up to date`)} (fetched in last ${days} days)`);
      if (staleCount > 0) {
        console.log(`  ${chalk.yellow(`${staleCount} stale`)} (fetched, but not recently)`);
      }
      if (neverFetched.n > 0) {
        console.log(`  ${chalk.red(`${neverFetched.n} never fetched`)}`);
      }

      // Top sources table
      const activeSources = perSource.filter((s) => s.totalReleases > 0 || s.recentReleases > 0);
      if (activeSources.length > 0) {
        console.log(chalk.bold("\nSources by Activity\n"));
        const sourceTable = new Table({
          head: [
            chalk.cyan("Source"),
            chalk.cyan("Org"),
            chalk.cyan("Type"),
            chalk.cyan("Total"),
            chalk.cyan(`Last ${days}d`),
            chalk.cyan("Last Fetched"),
          ],
        });
        for (const s of activeSources) {
          sourceTable.push([
            s.sourceName,
            s.orgName ?? chalk.dim("—"),
            s.sourceType,
            String(s.totalReleases),
            s.recentReleases > 0 ? chalk.green(String(s.recentReleases)) : chalk.dim("0"),
            timeAgo(s.lastFetchedAt) ?? chalk.dim("never"),
          ]);
        }
        console.log(sourceTable.toString());
      }

      // Recent fetch activity
      if (recentFetches.length > 0) {
        console.log(chalk.bold("\nRecent Fetch Activity\n"));
        const activityTable = new Table({
          head: [
            chalk.cyan("Source"),
            chalk.cyan("Org"),
            chalk.cyan("Status"),
            chalk.cyan("Found"),
            chalk.cyan("New"),
            chalk.cyan("Total"),
            chalk.cyan("Duration"),
            chalk.cyan("When"),
          ],
        });
        for (const f of recentFetches) {
          const statusLabel = f.status === "success"
            ? chalk.green("success")
            : f.status === "error"
              ? chalk.red("error")
              : chalk.dim("no change");
          activityTable.push([
            f.sourceName,
            f.orgName ?? chalk.dim("—"),
            statusLabel,
            String(f.releasesFound),
            f.releasesInserted > 0 ? chalk.green(String(f.releasesInserted)) : chalk.dim("0"),
            String(f.totalReleases),
            f.durationMs ? `${(f.durationMs / 1000).toFixed(1)}s` : chalk.dim("—"),
            timeAgo(f.createdAt) ?? "",
          ]);
        }
        console.log(activityTable.toString());
      } else {
        console.log(chalk.dim("\nNo fetch activity recorded yet. Run `released fetch` to start."));
      }
    });
}
