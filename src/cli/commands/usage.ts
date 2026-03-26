import { Command } from "commander";
import chalk from "chalk";
import { sql, gte } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { usageLog } from "../../db/schema.js";

export function registerUsageCommand(program: Command) {
  program
    .command("usage")
    .description("Show API token usage summary")
    .option("--days <n>", "Number of days to look back", "7")
    .action(async (opts: { days: string }) => {
      const db = getDb();
      const days = parseInt(opts.days, 10) || 7;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // Total usage
      const totals = await db
        .select({
          totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
          totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(usageLog)
        .where(gte(usageLog.createdAt, since));

      const total = totals[0];
      console.log(chalk.bold(`Token usage (last ${days} days)`));
      console.log();
      console.log(`  Total requests:  ${total.count}`);
      console.log(`  Input tokens:    ${total.totalInput.toLocaleString()}`);
      console.log(`  Output tokens:   ${total.totalOutput.toLocaleString()}`);
      console.log(`  Total tokens:    ${(total.totalInput + total.totalOutput).toLocaleString()}`);

      // By operation
      const byOperation = await db
        .select({
          operation: usageLog.operation,
          totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
          totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(usageLog)
        .where(gte(usageLog.createdAt, since))
        .groupBy(usageLog.operation);

      if (byOperation.length > 0) {
        console.log();
        console.log(chalk.bold("By operation:"));
        for (const row of byOperation) {
          console.log(
            `  ${chalk.cyan(row.operation.padEnd(12))}  ${row.count} calls  |  ${row.totalInput.toLocaleString()} in / ${row.totalOutput.toLocaleString()} out`,
          );
        }
      }

      // By model
      const byModel = await db
        .select({
          model: usageLog.model,
          totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
          totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
          count: sql<number>`COUNT(*)`,
        })
        .from(usageLog)
        .where(gte(usageLog.createdAt, since))
        .groupBy(usageLog.model);

      if (byModel.length > 0) {
        console.log();
        console.log(chalk.bold("By model:"));
        for (const row of byModel) {
          console.log(
            `  ${chalk.cyan(row.model.padEnd(30))}  ${row.count} calls  |  ${row.totalInput.toLocaleString()} in / ${row.totalOutput.toLocaleString()} out`,
          );
        }
      }
    });
}
