import { Command } from "commander";
import chalk from "chalk";
import { sendTestNotification } from "../../../api/client.js";

export function registerNotifyAdminCommand(parent: Command): void {
  const notify = parent
    .command("notify")
    .description("Exercise the email notification pipeline")
    .showSuggestionAfterError(true);

  notify
    .command("test")
    .description("Send a sample cron-report email via the API's send_email binding")
    .option("--to <email>", "Override recipient (must be verified in Cloudflare Email Routing)")
    .option("--status <status>", "Fabricated status: done | degraded | dispatch_failed | aborted", "done")
    .option("--cron <name>", "Cron name to impersonate", "scrape-agent-sweep")
    .option("--plain", "Send a plain test email instead of the cron-report format")
    .option("--subject <text>", "Subject when --plain is set")
    .option("--body <text>", "Body when --plain is set")
    .option("--json", "Machine-readable JSON output")
    .action(
      async (opts: {
        to?: string;
        status: "done" | "degraded" | "dispatch_failed" | "aborted";
        cron: string;
        plain?: boolean;
        subject?: string;
        body?: string;
        json?: boolean;
      }) => {
        const result = await sendTestNotification({
          to: opts.to,
          status: opts.status,
          cronName: opts.cron,
          plain: opts.plain,
          subject: opts.subject,
          body: opts.body,
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.ok) {
          console.log(chalk.green("✓ Sent"));
          if ("sent" in result.result && result.result.sent) {
            console.log(chalk.gray(`  Check ${opts.to ?? "EMAIL_NOTIFY_TO"} for the message.`));
          }
        } else {
          const reason = "reason" in result.result ? result.result.reason : "unknown";
          const detail = "error" in result.result && result.result.error ? ` — ${result.result.error}` : "";
          console.log(chalk.yellow(`⚠ Not sent: ${reason}${detail}`));
          if (reason === "no_binding") {
            console.log(chalk.gray("  The SEND_EMAIL binding is missing. Deploy the API Worker with send_email configured."));
          } else if (reason === "disabled") {
            console.log(chalk.gray("  EMAIL_NOTIFY_ENABLED=false. Flip it in wrangler.jsonc to re-enable."));
          } else if (reason === "no_recipient") {
            console.log(chalk.gray("  Set EMAIL_NOTIFY_TO in wrangler.jsonc or pass --to."));
          }
        }
      },
    );
}
