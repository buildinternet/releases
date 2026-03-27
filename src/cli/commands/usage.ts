import { Command } from "commander";
import chalk from "chalk";
import { sql, gte, and, isNotNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { getDb } from "../../db/connection.js";
import { usageLog } from "../../db/schema.js";
import { daysAgoIso } from "../../lib/dates.js";

interface BreakdownRow {
  label: string | null;
  totalInput: number;
  totalOutput: number;
  count: number;
}

function usageByColumn(db: ReturnType<typeof getDb>, column: SQLiteColumn, since: string) {
  return db
    .select({
      label: column,
      totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
      totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(usageLog)
    .where(gte(usageLog.createdAt, since))
    .groupBy(column) as Promise<BreakdownRow[]>;
}

function printBreakdown(title: string, rows: BreakdownRow[], labelWidth: number) {
  if (rows.length === 0) return;
  console.log();
  console.log(chalk.bold(title));
  for (const row of rows) {
    const label = (row.label ?? "(unattributed)").padEnd(labelWidth);
    console.log(
      `  ${chalk.cyan(label)}  ${row.count} calls  |  ${row.totalInput.toLocaleString()} in / ${row.totalOutput.toLocaleString()} out`,
    );
  }
}

export function registerUsageCommand(program: Command) {
  program
    .command("usage")
    .description("Show API token usage summary")
    .option("--days <n>", "Number of days to look back", "7")
    .addHelpText("after", `
Examples:
  released usage
  released usage --days 30`)
    .action(async (opts: { days: string }) => {
      const db = getDb();
      const days = parseInt(opts.days, 10) || 7;
      const since = daysAgoIso(days);

      const [totals, byOperation, byModel, bySource] = await Promise.all([
        db
          .select({
            totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
            totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
            count: sql<number>`COUNT(*)`,
          })
          .from(usageLog)
          .where(gte(usageLog.createdAt, since)),
        usageByColumn(db, usageLog.operation, since),
        usageByColumn(db, usageLog.model, since),
        db
          .select({
            label: usageLog.sourceSlug,
            totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
            totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
            count: sql<number>`COUNT(*)`,
          })
          .from(usageLog)
          .where(and(gte(usageLog.createdAt, since), isNotNull(usageLog.sourceSlug)))
          .groupBy(usageLog.sourceSlug) as Promise<BreakdownRow[]>,
      ]);

      const total = totals[0];
      console.log(chalk.bold(`Token usage (last ${days} days)`));
      console.log();
      console.log(`  Total requests:  ${total.count}`);
      console.log(`  Input tokens:    ${total.totalInput.toLocaleString()}`);
      console.log(`  Output tokens:   ${total.totalOutput.toLocaleString()}`);
      console.log(`  Total tokens:    ${(total.totalInput + total.totalOutput).toLocaleString()}`);

      printBreakdown("By operation:", byOperation, 12);
      printBreakdown("By model:", byModel, 30);
      printBreakdown("By source:", bySource, 20);
    });
}
