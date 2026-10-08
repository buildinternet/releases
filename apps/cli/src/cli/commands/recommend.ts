import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { writeJson } from "../../lib/output.js";
import { apiFetch } from "../../api/core.js";
import { ApiError } from "../../lib/errors.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { promptConfirm } from "../../lib/confirm.js";
import { markDryRun } from "../../lib/dry-run.js";
import { assertCleanIdentifier } from "../../lib/validate-input.js";
import { logger } from "@buildinternet/releases-lib/logger";

const MAX_URL = 2048;
const MAX_NOTE = 4000;
const MAX_CONTACT = 200;
const POST_TIMEOUT_MS = 10_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidateUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate and normalize a submitted URL. Mirrors the API's
 * normalizeSubmittedUrl (workers/api/src/routes/recommendations.ts): a missing
 * scheme defaults to https, and only http(s) is accepted. Returning the
 * normalized form gives the operator queue a consistent value to dedupe on.
 */
export function validateUrl(raw: string): ValidateUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Enter a release notes URL." };
  if (trimmed.length > MAX_URL) {
    return { ok: false, error: `URL is too long (max ${MAX_URL} chars).` };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "URL must start with http:// or https://." };
  }
  if (!url.hostname) return { ok: false, error: "That doesn't look like a valid URL." };
  return { ok: true, url: url.toString() };
}

export interface RecommendationPayload {
  type: "source";
  url: string;
  note?: string;
  contactEmail?: string;
  surface: "cli";
}

export function buildRecommendationPayload(
  url: string,
  opts: { note?: string; contact?: string },
): RecommendationPayload {
  const note = opts.note?.trim();
  const contactEmail = opts.contact?.trim();
  return {
    type: "source",
    url,
    note: note || undefined,
    contactEmail: contactEmail || undefined,
    surface: "cli",
  };
}

async function resolveUrl(arg: string | undefined): Promise<string | null> {
  if (arg && arg.trim()) return arg;
  if (!process.stdin.isTTY) {
    const piped = (await Bun.stdin.text()).trim();
    return piped.length ? piped : null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      chalk.bold("Release notes URL? ") + chalk.dim("(blank to cancel)\n> "),
    );
    return answer.trim().length ? answer : null;
  } finally {
    rl.close();
  }
}

/**
 * Resolve an optional field: use the provided flag value if present, otherwise
 * prompt in an interactive terminal, otherwise skip. Returns undefined when
 * nothing is supplied. Non-TTY callers never block on input.
 */
async function resolveOptional(
  label: string,
  provided: string | undefined,
): Promise<string | undefined> {
  if (provided !== undefined) return provided.trim() || undefined;
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(chalk.dim(`${label} (optional, blank to skip)\n> `));
    return answer.trim().length ? answer.trim() : undefined;
  } finally {
    rl.close();
  }
}

/**
 * Legacy mapping from the API's old flat `{ error: "<code>" }` body to a
 * friendly message. The API now returns the standardized nested envelope
 * (`{ error: { code, type, message } }`), which `apiFetch`/`ApiError`
 * already resolve to a human message directly — `postRecommendation` no
 * longer calls this. Kept (and exported) for its existing characterization
 * coverage; safe to remove once that coverage is retired.
 */
export function submitErrorMessage(error: string | undefined, status: number): string {
  switch (error) {
    case "url_required":
      return "That URL was rejected — provide a valid http(s) URL.";
    case "invalid_email":
      return "The contact email looks invalid — fix it or omit --contact.";
    case "rate_limited":
      return "Too many submissions. Please try again in a minute.";
    case "recommendations_disabled":
      return "Submissions are temporarily disabled. Please try again later.";
    case "payload_too_large":
      return "That submission is too large.";
    default:
      return `server returned ${status}`;
  }
}

async function postRecommendation(
  payload: RecommendationPayload,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const json = await apiFetch<{ ok?: boolean; id?: string }>("/v1/recommendations", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!json.ok || !json.id) return { ok: false, error: "unexpected response" };
    return { ok: true, id: json.id };
  } catch (err) {
    const error = err instanceof ApiError ? err.serverMessage : apiFetchErrorMessage(err);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * apiFetch wraps transport-level failures (including an AbortController
 * timeout) in a descriptive "API request failed on POST … : <detail>"
 * envelope, preserving the original error as `cause`. Surface just that
 * original detail, matching the previous raw `fetch` catch block's message.
 */
function apiFetchErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : err.message;
  }
  return String(err);
}

export function registerSubmitCommand(parent: Command): void {
  parent
    .command("submit")
    .description("Suggest a changelog or release-notes URL for the registry")
    .argument("[url]", "Release notes URL (omit to type interactively or pipe via stdin)")
    .option("--note <text>", "Extra context: product name, GitHub repo, or feed quirks")
    .option("--contact <email>", "Email to notify once it's reviewed (optional)")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Print the payload without sending")
    .action(
      async (
        urlArg: string | undefined,
        opts: { note?: string; contact?: string; json?: boolean; dryRun?: boolean },
      ) => {
        const raw = await resolveUrl(urlArg);
        if (raw === null) {
          logger.info(chalk.dim("Cancelled — nothing submitted."));
          process.exit(0);
        }
        const validated = validateUrl(raw);
        if (!validated.ok) {
          logger.error(validated.error);
          process.exit(1);
        }

        const note = await resolveOptional("Additional info", opts.note);
        if (note && note.length > MAX_NOTE) {
          logger.error(`Note is too long (max ${MAX_NOTE} chars).`);
          process.exit(1);
        }
        const contact = await resolveOptional("Contact email", opts.contact);
        if (contact && (contact.length > MAX_CONTACT || !EMAIL_PATTERN.test(contact))) {
          logger.error("That contact email looks invalid — fix it or omit --contact.");
          process.exit(1);
        }

        const payload = buildRecommendationPayload(validated.url, { note, contact });

        if (opts.dryRun) {
          if (opts.json) await writeJson({ dryRun: true, payload });
          else logger.info(chalk.dim("[dry-run] would POST:\n") + JSON.stringify(payload, null, 2));
          return;
        }

        const result = await postRecommendation(payload);
        if (result.ok) {
          if (opts.json) await writeJson({ ok: true, id: result.id });
          else
            logger.info(
              chalk.green("Thanks — your suggestion is in the review queue ") +
                chalk.dim(`(id: ${result.id})`),
            );
          return;
        }
        if (opts.json) await writeJson({ ok: false, error: result.error });
        else logger.error(`Couldn't submit the URL: ${result.error}`);
        process.exit(1);
      },
    );
}

// Mirrors the API's RECOMMENDATION_STATUSES / RECOMMENDATION_TYPES (packages/core
// schema). When @buildinternet/releases-api-types ships the recommendation
// shapes, these locals can be replaced by its exports.
const RECOMMENDATION_STATUSES = ["new", "triaged", "closed"] as const;
const RECOMMENDATION_STATUSES_SET = new Set<string>(RECOMMENDATION_STATUSES);

interface RecommendationRow {
  id: string;
  createdAt: number;
  type: string;
  url: string;
  note: string | null;
  contactEmail: string | null;
  status: string;
  archived?: boolean;
  surface?: string;
}
interface RecommendationListResponse {
  items: RecommendationRow[];
  nextCursor: string | null;
}

/**
 * Translate apiFetch's thrown error into a clean CLI failure. A 404 on a write
 * becomes a short "not found"; anything else surfaces the API message rather
 * than a stack trace. Always exits non-zero.
 */
function failFromApiError(err: unknown, id: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("(404)")) {
    logger.error(`No recommendation found with id ${id}.`);
  } else {
    logger.error(msg);
  }
  process.exit(1);
}

/** `POST /v1/admin/recommendations/:id/notify-added` request body. */
export interface NotifyAddedBody {
  orgSlug: string;
  sourceSlug?: string;
}

/** `POST /v1/admin/recommendations/:id/notify-added` success body. */
export interface NotifyAddedResult {
  ok: true;
  sent: boolean;
  reason?: "already_notified";
  notifiedAt: number | null;
  registryUrl?: string;
  contactEmail?: string;
}

/**
 * Build the notify-added request body. `orgSlug` is required by the API so
 * the email can link a live registry URL; `sourceSlug` is optional and
 * omitted when blank so we don't send an empty string.
 */
export function buildNotifyAddedBody(orgSlug: string, sourceSlug?: string): NotifyAddedBody {
  const org = orgSlug.trim();
  assertCleanIdentifier(org, "org");
  const source = sourceSlug?.trim();
  if (source) assertCleanIdentifier(source, "source");
  return source ? { orgSlug: org, sourceSlug: source } : { orgSlug: org };
}

export function registerRecommendationAdminCommand(parent: Command): void {
  const cmd = parent
    .command("recommendations")
    .description("Inspect and triage submitted source recommendations");

  cmd
    .command("list")
    .description("List submitted recommendations (newest first)")
    .option("--status <status>", "Filter by status: new | triaged | closed")
    .option("--type <type>", "Filter by type: source")
    .option("--include-archived", "Include archived rows (hidden by default)")
    .option("--limit <n>", "Max rows (default 50)")
    .option("--cursor <cursor>", "Pagination cursor from a previous page")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        status?: string;
        type?: string;
        includeArchived?: boolean;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const qs = new URLSearchParams();
        if (opts.status) qs.set("status", opts.status);
        if (opts.type) qs.set("type", opts.type);
        if (opts.includeArchived) qs.set("includeArchived", "true");
        if (opts.limit) qs.set("limit", opts.limit);
        if (opts.cursor) qs.set("cursor", opts.cursor);
        const data = await apiFetch<RecommendationListResponse>(
          `/v1/admin/recommendations${qs.size ? `?${qs}` : ""}`,
        );

        if (opts.json) {
          await writeJson(data);
          return;
        }
        if (!data.items.length) {
          logger.info(chalk.dim("No recommendations yet."));
          return;
        }
        for (const r of data.items) {
          const when = new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ");
          const archived = r.archived ? chalk.yellow(" [archived]") : "";
          const head = `${chalk.bold(r.id)}  ${chalk.dim(when)}  ${chalk.cyan(r.type)}/${r.status}${archived}`;
          const contact = r.contactEmail ? chalk.dim(` <${stripAnsi(r.contactEmail)}>`) : "";
          logger.info(`${head}${contact}`);
          // Defense-in-depth: the API strips control chars at ingest; stripAnsi
          // here protects the operator's terminal from any pre-existing rows.
          logger.info(`  ${chalk.underline(stripAnsi(r.url))}`);
          if (r.note) {
            logger.info(`  ${chalk.dim(stripAnsi(r.note).replace(/\s+/g, " ").slice(0, 200))}`);
          }
        }
        if (data.nextCursor) {
          logger.info(
            chalk.dim(`More: releases admin recommendations list --cursor ${data.nextCursor}`),
          );
        }
      },
    );

  cmd
    .command("triage")
    .description("Set the triage status of a recommendation")
    .argument("<id>", "Recommendation id (rec_…)")
    .requiredOption("--status <status>", "new | triaged | closed")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { status: string; json?: boolean }) => {
      if (!RECOMMENDATION_STATUSES_SET.has(opts.status)) {
        logger.error(`--status must be one of: ${RECOMMENDATION_STATUSES.join(", ")}`);
        process.exit(1);
      }
      let updated: RecommendationRow;
      try {
        updated = await apiFetch<RecommendationRow>(
          `/v1/recommendations/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ status: opts.status }),
          },
        );
      } catch (err) {
        failFromApiError(err, id);
      }
      if (opts.json) {
        await writeJson(updated);
        return;
      }
      logger.info(chalk.green(`Set ${chalk.bold(updated.id)} → status ${updated.status}`));
    });

  cmd
    .command("archive")
    .description("Archive a recommendation (hide it from the default list); --undo to restore")
    .argument("<id>", "Recommendation id (rec_…)")
    .option("--undo", "Restore an archived row instead of archiving it")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { undo?: boolean; json?: boolean }) => {
      const archived = !opts.undo;
      let updated: RecommendationRow;
      try {
        updated = await apiFetch<RecommendationRow>(
          `/v1/recommendations/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ archived }),
          },
        );
      } catch (err) {
        failFromApiError(err, id);
      }
      if (opts.json) {
        await writeJson(updated);
        return;
      }
      logger.info(chalk.green(`${archived ? "Archived" : "Restored"} ${chalk.bold(updated.id)}`));
    });

  cmd
    .command("delete")
    .description("Permanently delete a recommendation (prefer `archive` for a reversible removal)")
    .argument("<id>", "Recommendation id (rec_…)")
    .option("-y, --yes", "Skip the confirmation prompt (required in non-interactive contexts)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      if (!opts.yes) {
        const confirmed = await promptConfirm(
          `Type the recommendation id to permanently delete it (${id}): `,
          id,
        );
        if (!confirmed) {
          logger.error(
            "Delete cancelled — id not confirmed. Pass --yes to skip the prompt in scripts.",
          );
          process.exit(1);
        }
      }
      let result: { deleted: boolean; id: string };
      try {
        result = await apiFetch<{ deleted: boolean; id: string }>(
          `/v1/recommendations/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
      } catch (err) {
        failFromApiError(err, id);
      }
      if (opts.json) {
        await writeJson(result);
        return;
      }
      logger.info(chalk.green(`Deleted ${chalk.bold(result.id)}`));
    });

  cmd
    .command("notify-added")
    .description(
      "Email the submitter that their suggested source was added (opt-in; never sent by triage/close/archive)",
    )
    .argument("<id>", "Recommendation id (rec_…)")
    .requiredOption("--org <org>", "Org slug or org_… id of the onboarded listing")
    .option("--source <source>", "Optional source slug or src_… id under that org")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be sent without emailing")
    .action(
      async (
        id: string,
        opts: { org: string; source?: string; json?: boolean; dryRun?: boolean },
      ) => {
        assertCleanIdentifier(id, "recommendation id");
        const body = buildNotifyAddedBody(opts.org, opts.source);
        const path = `/v1/admin/recommendations/${encodeURIComponent(id)}/notify-added`;

        if (opts.dryRun) {
          if (opts.json) {
            await writeJson(markDryRun({ wouldPost: path, body }));
            return;
          }
          const listing = body.sourceSlug ? `${body.orgSlug}/${body.sourceSlug}` : body.orgSlug;
          logger.info(
            chalk.dim(`[dry-run] Would email the submitter of ${id} that ${listing} was added.`),
          );
          return;
        }

        let result: NotifyAddedResult;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
        try {
          result = await apiFetch<NotifyAddedResult>(path, {
            method: "POST",
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          // 404 here can mean the recommendation, org, or source is missing —
          // surface the API message instead of assuming a bad rec id.
          const msg =
            err instanceof ApiError
              ? err.serverMessage
              : err instanceof Error
                ? err.message
                : String(err);
          logger.error(msg);
          process.exit(1);
        } finally {
          clearTimeout(timer);
        }
        if (opts.json) {
          await writeJson(result);
          return;
        }
        if (result.sent) {
          const dest = result.contactEmail ? ` ${chalk.bold(result.contactEmail)}` : "";
          const url = result.registryUrl ? chalk.dim(` — ${result.registryUrl}`) : "";
          logger.info(chalk.green(`Notified${dest}`) + url);
          return;
        }
        if (result.reason === "already_notified") {
          const dest = result.contactEmail ? ` ${result.contactEmail}` : "";
          logger.info(chalk.yellow(`Already notified${dest} — not sent again`));
          return;
        }
        logger.info(chalk.yellow(result.reason ? `Not sent (${result.reason})` : "Not sent"));
      },
    );
}
