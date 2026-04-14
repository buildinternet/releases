import { Command } from "commander";
import chalk from "chalk";
import { getUsageStats, type UsageBreakdownRow } from "../../db/queries.js";

function printBreakdown(title: string, rows: UsageBreakdownRow[], labelWidth: number) {
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
  releases admin stats usage
  releases admin stats usage --days 30`)
    .action(async (opts: { days: string }) => {
      const days = parseInt(opts.days, 10) || 7;
      const stats = await getUsageStats(days);

      const total = stats.totals;
      console.log(chalk.bold(`Token usage (last ${days} days)`));
      console.log();
      console.log(`  Total requests:  ${total.count}`);
      console.log(`  Input tokens:    ${total.totalInput.toLocaleString()}`);
      console.log(`  Output tokens:   ${total.totalOutput.toLocaleString()}`);
      console.log(`  Total tokens:    ${(total.totalInput + total.totalOutput).toLocaleString()}`);

      printBreakdown("By operation:", stats.byOperation, 12);
      printBreakdown("By model:", stats.byModel, 30);
      printBreakdown("By source:", stats.bySource, 20);
    });
}
