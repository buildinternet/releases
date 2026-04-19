import { Command } from "commander";
import chalk from "chalk";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  getWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  testWebhookSubscription,
  rotateWebhookSecret,
  getWebhookDeliveries,
  type WebhookDeliveryRow,
} from "../../../api/client.js";

export function registerWebhookAdminCommand(parent: Command): void {
  const webhook = parent
    .command("webhook")
    .description("Manage webhook subscriptions")
    .showSuggestionAfterError(true);

  webhook
    .command("add")
    .description("Create a new webhook subscription")
    .requiredOption("--org <slug>", "Org ID or slug to scope the subscription")
    .requiredOption("--url <url>", "HTTPS endpoint to deliver events to")
    .option("--source <slug>", "Restrict deliveries to a single source (ID or slug)")
    .option("--description <text>", "Human-readable description")
    .option("--json", "Machine-readable JSON output")
    .action(
      async (opts: {
        org: string;
        url: string;
        source?: string;
        description?: string;
        json?: boolean;
      }) => {
        const sub = await createWebhookSubscription({
          orgId: opts.org,
          url: opts.url,
          sourceId: opts.source,
          description: opts.description,
        });

        if (opts.json) {
          console.log(JSON.stringify(sub, null, 2));
          return;
        }

        console.log(chalk.green(`Created ${sub.id}`));
        console.log(`  URL: ${sub.url}`);
        console.log(chalk.bold("Signing key (shown once — save it now):"));
        console.log(chalk.yellow(sub.signingKey));
        console.log(
          chalk.gray(
            "Re-running 'add' generates a new subscription. Use 'rotate-secret' to regenerate.",
          ),
        );
      },
    );

  webhook
    .command("list")
    .description("List webhook subscriptions for an org")
    .requiredOption("--org <slug>", "Org ID or slug to list subscriptions for")
    .option("--enabled", "Show only enabled subscriptions")
    .option("--disabled", "Show only disabled subscriptions")
    .option("--json", "Machine-readable JSON output")
    .action(
      async (opts: { org: string; enabled?: boolean; disabled?: boolean; json?: boolean }) => {
        let enabledFilter: boolean | undefined;
        if (opts.enabled) enabledFilter = true;
        else if (opts.disabled) enabledFilter = false;

        const result = await listWebhookSubscriptions({ org: opts.org, enabled: enabledFilter });
        const subs = result.subscriptions;

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (subs.length === 0) {
          console.log("No subscriptions.");
          return;
        }

        for (const s of subs) {
          const dot = s.enabled ? chalk.green("●") : chalk.red("●");
          const desc = s.description ? chalk.gray(` — ${s.description}`) : "";
          console.log(`${dot} ${chalk.cyan(s.id)} ${s.url}${desc}`);
        }
      },
    );

  webhook
    .command("show")
    .description("Show details for a webhook subscription")
    .argument("<id>", "Subscription ID (whk_...)")
    .option("--json", "Machine-readable JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const sub = await getWebhookSubscription(id);
      if (!sub) {
        console.error(chalk.red(`Subscription not found: ${id}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(sub, null, 2));
        return;
      }

      const fields: Array<[string, unknown]> = [
        ["id", sub.id],
        ["orgId", sub.orgId],
        ["url", sub.url],
        ["sourceId", sub.sourceId ?? "(all)"],
        ["enabled", sub.enabled],
        ["description", sub.description ?? ""],
        ["secretVersion", sub.secretVersion],
        ["createdAt", sub.createdAt],
        ["lastSuccessAt", sub.lastSuccessAt ?? ""],
        ["lastErrorAt", sub.lastErrorAt ?? ""],
        ["lastErrorMsg", sub.lastErrorMsg ?? ""],
        ["consecutiveFailures", sub.consecutiveFailures],
        ["disabledReason", sub.disabledReason ?? ""],
      ];

      for (const [key, val] of fields) {
        console.log(`${chalk.gray(key + ":")} ${val}`);
      }
    });

  webhook
    .command("edit")
    .description("Update a webhook subscription")
    .argument("<id>", "Subscription ID (whk_...)")
    .option("--url <url>", "New HTTPS endpoint URL")
    .option("--description <text>", "New description")
    .option("--enable", "Re-enable the subscription")
    .option("--disable", "Disable the subscription")
    .action(
      async (
        id: string,
        opts: { url?: string; description?: string; enable?: boolean; disable?: boolean },
      ) => {
        const patch: { url?: string; description?: string; enabled?: boolean } = {};
        if (opts.url !== undefined) patch.url = opts.url;
        if (opts.description !== undefined) patch.description = opts.description;
        if (opts.enable) patch.enabled = true;
        else if (opts.disable) patch.enabled = false;

        if (Object.keys(patch).length === 0) {
          console.error(
            chalk.red("No changes specified. Use --url, --description, --enable, or --disable."),
          );
          process.exit(1);
        }

        await updateWebhookSubscription(id, patch);
        console.log(chalk.green(`Updated ${id}`));
      },
    );

  webhook
    .command("remove")
    .description("Delete a webhook subscription")
    .argument("<id>", "Subscription ID (whk_...)")
    .action(async (id: string) => {
      await deleteWebhookSubscription(id);
      console.log(chalk.yellow(`Removed ${id}`));
    });

  webhook
    .command("test")
    .description("Enqueue a synthetic test event for a subscription")
    .argument("<id>", "Subscription ID (whk_...)")
    .action(async (id: string) => {
      const result = await testWebhookSubscription(id);
      console.log(chalk.green(`Enqueued test event ${result.eventId} for ${id}`));
    });

  webhook
    .command("rotate-secret")
    .description("Rotate the signing key for a subscription")
    .argument("<id>", "Subscription ID (whk_...)")
    .action(async (id: string) => {
      const result = await rotateWebhookSecret(id);
      console.log(chalk.green(`Rotated to v${result.secretVersion}`));
      console.log(chalk.bold("New signing key (shown once — save it now):"));
      console.log(chalk.yellow(result.signingKey));
    });

  webhook
    .command("deliveries")
    .description("Show recent delivery attempts for a subscription")
    .argument("<id>", "Subscription ID (whk_...)")
    .option("--failed", "Show only failed deliveries")
    .option("--limit <n>", "Max rows to return", (v) => parseInt(v, 10))
    .option("--json", "Machine-readable JSON output")
    .action(async (id: string, opts: { failed?: boolean; limit?: number; json?: boolean }) => {
      const data = await getWebhookDeliveries(id, {
        failed: opts.failed,
        limit: opts.limit,
      });

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const rows: WebhookDeliveryRow[] = data.data?.[0]?.rows ?? data.rows ?? [];

      if (rows.length === 0) {
        console.log("No deliveries found.");
        return;
      }

      for (const row of rows) {
        const ts = row.timestamp ?? "";
        const outcome = row.outcome ?? "unknown";
        const eventId = row.event_id ?? "";
        const status = row.http_status != null ? String(row.http_status) : "—";
        const latency = row.latency_ms != null ? `${row.latency_ms}ms` : "—";
        const suffix = row.error_message ? chalk.gray(` — ${row.error_message}`) : "";
        const outcomeStr = outcome === "success" ? chalk.green(outcome) : chalk.red(outcome);
        console.log(`[${ts}] ${outcomeStr} ${eventId} ${status}/${latency}${suffix}`);
      }
    });
}
