/**
 * `releases admin webhook …` — manage outbound webhook subscriptions. Thin
 * wrapper over the root-key-gated `/v1/webhooks` routes (buildinternet/releases#343,
 * #1505); the admin gate is applied by `gateAdminSubtree` in program.ts. Mirrors
 * the `admin oauth client` verb shape.
 *
 * The subscriber-facing `releases webhook verify` (local signature check) lives
 * separately at top level in `../webhook.ts` — it needs no auth.
 */
import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../../lib/output.js";
import { markDryRun } from "../../../lib/dry-run.js";
import { findOrg } from "../../../api/orgs.js";
import { findSource } from "../../../api/sources.js";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  getWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  rotateWebhookSecret,
  testWebhookSubscription,
  getWebhookDeliveries,
  type WebhookSubscription,
  type WebhookDeliveryRow,
} from "../../../api/webhooks.js";
import { renderTable } from "../../render/table.js";
import { orgNotFound, sourceNotFound } from "../../suggest.js";

/** Resolve an org slug (or id) to its id, or exit 1 with did-you-mean suggestions. */
async function resolveOrgId(slug: string): Promise<string> {
  const org = await findOrg(slug);
  if (!org) return orgNotFound(slug);
  return org.id;
}

/** Resolve a source slug (or src_ id) to its id, or exit 1 (AmbiguousSourceError propagates). */
async function resolveSourceId(identifier: string): Promise<string> {
  const src = await findSource(identifier);
  if (!src) return sourceNotFound(identifier);
  return src.id;
}

function statusLabel(sub: WebhookSubscription): string {
  return sub.enabled ? chalk.green("enabled") : chalk.red("disabled");
}

/** Parse + clamp `--limit` to the API's accepted range so no garbage reaches the URL. */
function parseLimit(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n === 0) return 20;
  return Math.min(100, Math.max(1, n));
}

function printSubscription(sub: WebhookSubscription): void {
  logger.info(`${chalk.bold(sub.id)}  ${statusLabel(sub)}`);
  logger.info(`  url:     ${sub.url}`);
  logger.info(`  org:     ${sub.orgId}`);
  logger.info(`  source:  ${sub.sourceId ?? chalk.dim("(all org sources)")}`);
  if (sub.description) logger.info(`  desc:    ${sub.description}`);
  logger.info(`  secret:  v${sub.secretVersion}${chalk.dim(`  · created ${sub.createdAt}`)}`);
  logger.info(
    `  last ok: ${sub.lastSuccessAt ?? chalk.dim("—")}   failures: ${sub.consecutiveFailures}`,
  );
  if (sub.lastErrorAt) {
    logger.info(`  last err: ${sub.lastErrorAt} ${chalk.dim(sub.lastErrorMsg ?? "")}`);
  }
  if (!sub.enabled && sub.disabledReason) {
    logger.info(`  ${chalk.red(`disabled: ${sub.disabledReason}`)}`);
  }
}

/** True when a thrown error is the API's "deliveries not configured" signal (501). */
function isDeliveriesUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\(501\)|deliveries_unavailable|CF_API_TOKEN/.test(msg);
}

function renderDeliveries(rows: WebhookDeliveryRow[]): string {
  return renderTable({
    head: [
      { label: "Time", noTruncate: true },
      { label: "Format" },
      { label: "Outcome" },
      { label: "HTTP" },
      { label: "Latency" },
      { label: "Attempt" },
      { label: "Error" },
    ],
    rows: rows.map((r) => [
      r.timestamp ?? chalk.dim("—"),
      r.format?.trim() || chalk.dim("—"),
      r.outcome ?? chalk.dim("—"),
      r.http_status != null ? String(r.http_status) : chalk.dim("—"),
      r.latency_ms != null ? `${r.latency_ms}ms` : chalk.dim("—"),
      r.attempt != null ? String(r.attempt) : chalk.dim("—"),
      r.error_message ?? chalk.dim("—"),
    ]),
  });
}

export function registerWebhookAdminCommand(program: Command) {
  const webhook = program.command("webhook").description("Manage outbound webhook subscriptions");

  webhook
    .command("add")
    .description("Create a webhook subscription (signing key shown once)")
    .requiredOption("--org <slug>", "Owning org slug or id")
    .requiredOption("--url <url>", "HTTPS delivery URL")
    .option("--source <slug>", "Limit to one source (slug or src_ id); default = all org sources")
    .option("--description <text>", "Human-readable label")
    .option("--json", "Output JSON")
    .option("--dry-run", "Resolve org/source and show what would be created, without writing")
    .action(
      async (opts: {
        org: string;
        url: string;
        source?: string;
        description?: string;
        json?: boolean;
        dryRun?: boolean;
      }) => {
        const orgId = await resolveOrgId(opts.org);
        const sourceId = opts.source ? await resolveSourceId(opts.source) : undefined;
        if (opts.dryRun) {
          const plan = { orgId, url: opts.url, sourceId, description: opts.description };
          if (opts.json) return writeJson(markDryRun({ wouldCreate: plan }));
          logger.info(
            chalk.yellow(
              `[dry-run] Would create webhook subscription → ${opts.url} (org ${orgId}${sourceId ? `, source ${sourceId}` : ", all org sources"}).`,
            ),
          );
          return;
        }
        const result = await createWebhookSubscription({
          orgId,
          url: opts.url,
          sourceId,
          description: opts.description,
        });
        if (opts.json) return writeJson(result);
        printSubscription(result);
        logger.info("");
        logger.info(chalk.bold("Signing key (shown once — store it now):"));
        logger.info(`  ${chalk.green(result.signingKey)}`);
        logger.info(
          chalk.dim("  Re-derive only via `webhook rotate-secret` (invalidates the old key)."),
        );
      },
    );

  webhook
    .command("list")
    .description("List an org's webhook subscriptions")
    .requiredOption("--org <slug>", "Org slug or id (cross-org listing is not supported)")
    .option("--enabled", "Only enabled subscriptions")
    .option("--disabled", "Only disabled subscriptions")
    .option("--json", "Output JSON")
    .action(
      async (opts: { org: string; enabled?: boolean; disabled?: boolean; json?: boolean }) => {
        if (opts.enabled && opts.disabled) {
          logger.error("Pass at most one of --enabled / --disabled.");
          process.exit(1);
        }
        const orgId = await resolveOrgId(opts.org);
        let filter: { enabled?: boolean } | undefined;
        if (opts.enabled) filter = { enabled: true };
        else if (opts.disabled) filter = { enabled: false };
        const subscriptions = await listWebhookSubscriptions(orgId, filter);
        if (opts.json) return writeJson({ subscriptions });
        if (subscriptions.length === 0) {
          logger.info("No webhook subscriptions.");
          return;
        }
        console.log(
          renderTable({
            head: [
              { label: "ID", noTruncate: true },
              { label: "URL", noTruncate: true },
              { label: "Source" },
              { label: "Status" },
              { label: "Fails" },
            ],
            rows: subscriptions.map((s) => [
              s.id,
              s.url,
              s.sourceId ?? chalk.dim("all"),
              s.enabled ? "enabled" : "disabled",
              String(s.consecutiveFailures),
            ]),
          }),
        );
      },
    );

  webhook
    .command("show <id>")
    .description("Show one subscription plus its last 10 delivery attempts")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const sub = await getWebhookSubscription(id);
      if (!sub) {
        logger.error("Subscription not found.");
        process.exit(1);
      }
      let deliveries: WebhookDeliveryRow[] = [];
      let deliveriesUnavailable = false;
      try {
        deliveries = await getWebhookDeliveries(id, { limit: 10 });
      } catch (err) {
        if (isDeliveriesUnavailable(err)) deliveriesUnavailable = true;
        else throw err;
      }
      if (opts.json) return writeJson({ ...sub, deliveries });
      printSubscription(sub);
      logger.info("");
      if (deliveriesUnavailable) {
        logger.info(chalk.dim("Delivery history unavailable (Analytics Engine not configured)."));
      } else if (deliveries.length === 0) {
        logger.info(chalk.dim("No delivery attempts recorded."));
      } else {
        logger.info(chalk.bold("Recent deliveries:"));
        console.log(renderDeliveries(deliveries));
      }
    });

  webhook
    .command("edit <id>")
    .description("Update a subscription's url / description / enabled state")
    .option("--url <url>", "New HTTPS delivery URL (does not rotate the signing key)")
    .option("--description <text>", "New description")
    .option("--enable", "Enable the subscription (resets the failure counter)")
    .option("--disable", "Disable the subscription")
    .option("--json", "Output JSON")
    .option("--dry-run", "Show what would change without writing")
    .action(
      async (
        id: string,
        opts: {
          url?: string;
          description?: string;
          enable?: boolean;
          disable?: boolean;
          json?: boolean;
          dryRun?: boolean;
        },
      ) => {
        if (opts.enable && opts.disable) {
          logger.error("Pass at most one of --enable / --disable.");
          process.exit(1);
        }
        const fields: { url?: string; description?: string; enabled?: boolean } = {};
        if (opts.url !== undefined) fields.url = opts.url;
        if (opts.description !== undefined) fields.description = opts.description;
        if (opts.enable) fields.enabled = true;
        if (opts.disable) fields.enabled = false;
        if (Object.keys(fields).length === 0) {
          logger.error("Nothing to change. Pass --url, --description, --enable, or --disable.");
          process.exit(1);
        }
        if (opts.dryRun) {
          if (opts.json) return writeJson(markDryRun({ wouldUpdate: id, fields }));
          logger.info(chalk.yellow(`[dry-run] Would update subscription ${id}:`));
          for (const [k, v] of Object.entries(fields)) logger.info(`  ${k} → ${String(v)}`);
          return;
        }
        const updated = await updateWebhookSubscription(id, fields);
        if (opts.json) return writeJson(updated);
        printSubscription(updated);
      },
    );

  webhook
    .command("remove <id>")
    .description("Hard-delete a subscription")
    .option("--json", "Output JSON")
    .option("--dry-run", "Show what would be deleted without deleting")
    .action(async (id: string, opts: { json?: boolean; dryRun?: boolean }) => {
      if (opts.dryRun) {
        if (opts.json) return writeJson(markDryRun({ wouldDelete: id }));
        logger.info(chalk.yellow(`[dry-run] Would delete subscription ${id}.`));
        return;
      }
      await deleteWebhookSubscription(id);
      if (opts.json) return writeJson({ id, deleted: true });
      logger.info(`${id}: ${chalk.red("deleted")}`);
    });

  webhook
    .command("test <id>")
    .description("Enqueue a synthetic release.created event to the subscription URL")
    .option("--json", "Output JSON")
    .option("--dry-run", "Show what would be enqueued without sending")
    .action(async (id: string, opts: { json?: boolean; dryRun?: boolean }) => {
      if (opts.dryRun) {
        if (opts.json) return writeJson(markDryRun({ wouldTest: id }));
        logger.info(chalk.yellow(`[dry-run] Would enqueue a synthetic test event → ${id}.`));
        return;
      }
      const result = await testWebhookSubscription(id);
      if (opts.json) return writeJson(result);
      logger.info(`${chalk.green("enqueued")} test event ${chalk.dim(result.eventId)} → ${id}`);
    });

  webhook
    .command("rotate-secret <id>")
    .description("Rotate the signing key (new key shown once; old key invalidated)")
    .option("--json", "Output JSON")
    .option("--dry-run", "Show what would be rotated without invalidating the current key")
    .action(async (id: string, opts: { json?: boolean; dryRun?: boolean }) => {
      if (opts.dryRun) {
        if (opts.json) return writeJson(markDryRun({ wouldRotate: id }));
        logger.info(chalk.yellow(`[dry-run] Would rotate the signing key for ${id}.`));
        return;
      }
      const result = await rotateWebhookSecret(id);
      if (opts.json) return writeJson(result);
      logger.info(
        chalk.bold(`New signing key (v${result.secretVersion}, shown once — store it now):`),
      );
      logger.info(`  ${chalk.green(result.signingKey)}`);
    });

  webhook
    .command("deliveries <id>")
    .description("Show recent delivery attempts from Analytics Engine")
    .option("--failed", "Only failed attempts (retry / perm_fail / dlq / auto_disabled)")
    .option("--since <iso>", "Only attempts at or after this ISO timestamp (filtered client-side)")
    .option("--limit <n>", "Max attempts to fetch (default 20, max 100)", parseLimit)
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        opts: { failed?: boolean; since?: string; limit?: number; json?: boolean },
      ) => {
        let rows: WebhookDeliveryRow[];
        try {
          rows = await getWebhookDeliveries(id, { failed: opts.failed, limit: opts.limit });
        } catch (err) {
          if (isDeliveriesUnavailable(err)) {
            logger.error(
              "Delivery history unavailable — the API has no Analytics Engine query configured.",
            );
            process.exit(1);
          }
          throw err;
        }
        if (opts.since) {
          const cutoff = Date.parse(opts.since);
          if (Number.isNaN(cutoff)) {
            logger.error(`Invalid --since timestamp: ${opts.since}`);
            process.exit(1);
          }
          rows = rows.filter((r) => r.timestamp != null && Date.parse(r.timestamp) >= cutoff);
        }
        if (opts.json) return writeJson({ deliveries: rows });
        if (rows.length === 0) {
          logger.info("No delivery attempts.");
          return;
        }
        console.log(renderDeliveries(rows));
      },
    );
}
