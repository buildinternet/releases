import { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../render/table.js";
import {
  findOrg,
  getSourcesByOrg,
  listOrgs,
  createOrg,
  removeOrg,
  getOrgAccountsBySlug,
  linkOrgAccount,
  unlinkOrgAccount,
  addTagsToOrg,
  removeTagsFromOrg,
  getTagsForOrg,
  updateOrg,
  getOrgDependents,
  setOrgAvatar,
} from "../../api/orgs.js";
import { getProductsByOrg } from "../../api/products.js";
import { getAliases, setAliases, getOverview } from "../../api/sources.js";
import {
  githubAvatarUrl,
  faviconAvatarUrl,
  appStoreTrackId,
  appStoreArtworkUrl,
} from "../../lib/avatar-source.js";
import { promptConfirm } from "../../lib/confirm.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { orgNotFound } from "../suggest.js";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isValidCategory, CATEGORIES } from "@buildinternet/releases-core/categories";
import { SOURCE_DISCOVERY } from "@buildinternet/releases-core/source-enums";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { handlePageAll } from "../../lib/paginate.js";
import {
  DEFAULT_PAGE_SIZE,
  computePagination,
  formatTruncationWarning,
  type ListResponse,
} from "@buildinternet/releases-core/cli-contracts";
import { OVERVIEW_STALE_DAYS, overviewPreview } from "@buildinternet/releases-core/overview";
import type { ReleaseLocationItem } from "@buildinternet/releases-api-types";
import {
  formatOverviewFreshnessHint,
  formatOverviewFreshnessLine,
  isOverviewContentStale,
  overviewContentAgeDays,
} from "../../lib/overview-freshness.js";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { parseTagList } from "../../lib/flags.js";
import { buildNoticePatch, formatNotice, type EntityWithNotice } from "../../lib/notice.js";
import { registerOrgStubCommands, LOCATOR_KEYS } from "./org-stub.js";

// ── Shared action handlers ────────────────────────────────────────────────────

type OrgCreateOpts = {
  domain?: string;
  slug?: string;
  description?: string;
  category?: string;
  tags?: string;
  json?: boolean;
  strict?: boolean;
  dryRun?: boolean;
};

async function applyTagsToOrg(orgId: string, raw: string | undefined): Promise<void> {
  const tagList = parseTagList(raw);
  if (tagList.length > 0) await addTagsToOrg(orgId, tagList);
}

async function orgCreateAction(name: string, opts: OrgCreateOpts): Promise<void> {
  const slug = opts.slug ?? toSlug(name);

  if (opts.category && !isValidCategory(opts.category)) {
    logger.error(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`);
    process.exit(1);
  }

  // Guard against findOrg() resolving via domain alias rather than slug:
  // /v1/orgs/:id matches by ID, slug, or domain alias, so an exact slug match
  // is the only safe signal that we'd actually collide on slug uniqueness.
  const existing = await findOrg(slug);
  if (existing && existing.slug === slug) {
    if (opts.dryRun) {
      const tagList = parseTagList(opts.tags);
      if (opts.json)
        await writeJson(
          markDryRun({
            wouldCreate: false,
            existed: true,
            slug: existing.slug,
            name: existing.name,
            tagsToAdd: opts.strict ? [] : tagList,
            strictWouldFail: !!opts.strict,
          }),
        );
      else if (opts.strict)
        logger.warn(`[dry-run] Organization "${slug}" already exists; --strict would exit 1.`);
      else
        logger.warn(
          `[dry-run] Organization "${existing.name}" (${slug}) already exists — would return existing${tagList.length ? ` and add tags: ${tagList.join(", ")}` : ""}.`,
        );
      return;
    }
    // --strict bails before any reconciliation runs, preserving its original
    // "fail on duplicate" semantics. Tag reconciliation is a non-strict thing.
    if (opts.strict) {
      logger.error(`Organization with slug "${slug}" already exists.`);
      process.exit(1);
    }
    await applyTagsToOrg(existing.id, opts.tags);
    logger.info(`Organization already exists: ${existing.name} (${slug}) — returning existing`);
    if (opts.json) await writeJson({ ...existing, existed: true });
    return;
  }

  if (opts.dryRun) {
    const tagList = parseTagList(opts.tags);
    const plan = {
      wouldCreate: true,
      name,
      slug,
      domain: opts.domain ?? null,
      description: opts.description ?? null,
      category: opts.category ?? null,
      tagsToAdd: tagList,
    };
    if (opts.json) await writeJson(markDryRun(plan));
    else
      logger.warn(
        `[dry-run] Would create organization: ${name} (${slug})${tagList.length ? ` with tags: ${tagList.join(", ")}` : ""}`,
      );
    return;
  }

  // Race window: another process may have created this slug between our
  // findOrg() call above and the createOrg() below. Catch a uniqueness
  // conflict and re-read instead of erroring out — the second writer should
  // observe the same idempotent semantics as the first.
  let created;
  try {
    created = await createOrg(name, {
      slug,
      domain: opts.domain,
      description: opts.description,
      category: opts.category,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("already exists") ||
      msg.includes("UNIQUE constraint") ||
      msg.includes("conflict")
    ) {
      const racedExisting = await findOrg(slug);
      if (racedExisting && racedExisting.slug === slug) {
        if (opts.strict) {
          logger.error(`Organization with slug "${slug}" already exists.`);
          process.exit(1);
        }
        await applyTagsToOrg(racedExisting.id, opts.tags);
        logger.info(
          `Organization already exists: ${racedExisting.name} (${slug}) — returning existing`,
        );
        if (opts.json) await writeJson({ ...racedExisting, existed: true });
        return;
      }
    }
    throw err;
  }

  await applyTagsToOrg(created.id, opts.tags);

  if (opts.json) await writeJson({ ...created, existed: false });
  else logger.info(chalk.green(`Organization created: ${name} (${slug})`));
}

type OrgGetOpts = { json?: boolean };

async function orgGetAction(identifier: string, opts: OrgGetOpts): Promise<void> {
  const found = (await findOrg(identifier)) as EntityWithNotice<
    Awaited<ReturnType<typeof findOrg>>
  >;
  if (!found) return orgNotFound(identifier);

  const [accounts, orgProducts, linkedSources, orgTags, aliases, overview] = await Promise.all([
    getOrgAccountsBySlug(found.slug),
    getProductsByOrg(found.id),
    getSourcesByOrg(found.id),
    getTagsForOrg(found.id),
    getAliases("org", found.slug),
    getOverview("org", found.slug).catch(() => null),
  ]);

  if (opts.json) {
    await writeJson({
      ...found,
      accounts,
      products: orgProducts,
      sources: linkedSources,
      tags: orgTags,
      aliases,
      overview: overview?.content ?? null,
    });
    return;
  }

  // `status`/`locations` are stub-tier fields (#1947) added by the API detail
  // route; `Organization` is the core DB row type, not api-types' OrgDetailSchema,
  // so read defensively rather than widening the shared DB type.
  const stubFields = found as { status?: string; locations?: ReleaseLocationItem[] };
  const isStub = stubFields.status === "stub";
  console.log(
    `${chalk.bold(found.name)}${isStub ? `  ${chalk.yellow("stub · not yet tracked")}` : ""}`,
  );
  console.log(`  Slug:    ${found.slug}`);
  console.log(`  Domain:  ${found.domain ?? chalk.dim("—")}`);
  if (aliases.length > 0) console.log(`  Aliases: ${aliases.join(", ")}`);
  if (found.description) console.log(`  About:   ${found.description}`);
  console.log(`  Created: ${found.createdAt ?? chalk.dim("—")}`);
  console.log(`  Updated: ${found.updatedAt ?? chalk.dim("—")}`);
  if (found.category) console.log(`  Category: ${found.category}`);
  console.log(
    `  AI content: ${
      found.autoGenerateContent ? chalk.green("on (overviews + summaries)") : chalk.dim("off")
    }`,
  );
  // Field ships in api-types after the next publish; read defensively until then.
  const cadenceOverride = (found as { overviewCadenceDays?: number | null }).overviewCadenceDays;
  if (cadenceOverride != null)
    console.log(`  Overview cadence: every ${cadenceOverride}d ${chalk.dim("(manual override)")}`);
  if (orgTags.length > 0) console.log(`  Tags:    ${orgTags.join(", ")}`);
  if (found.notice) console.log(`  ${chalk.yellow(formatNotice(found.notice))}`);

  if (accounts.length > 0) {
    console.log();
    console.log(chalk.bold("Accounts:"));
    for (const a of accounts) console.log(`  ${chalk.cyan(a.platform)}  ${a.handle}`);
  }

  if (orgProducts.length > 0) {
    console.log();
    console.log(chalk.bold("Products:"));
    for (const p of orgProducts) {
      const urlLabel = p.url ? chalk.dim(` ${p.url}`) : "";
      console.log(`  ${chalk.cyan(p.slug)}  ${p.name}  (${p.sourceCount} sources)${urlLabel}`);
    }
  }

  if (linkedSources.length > 0) {
    console.log();
    console.log(chalk.bold("Sources:"));
    for (const s of linkedSources) {
      const statusLabel = s.isHidden
        ? "disabled"
        : s.consecutiveErrors && s.consecutiveErrors > 0
          ? "erroring"
          : "active";
      const statusColor = s.isHidden ? chalk.red : s.consecutiveErrors ? chalk.yellow : chalk.green;
      const status = statusColor(statusLabel.padEnd(16));
      const fetched = s.lastFetchedAt
        ? chalk.dim(s.lastFetchedAt.replace("T", " ").replace(/\.\d+Z$/, ""))
        : chalk.dim("never fetched");
      console.log(`  ${chalk.cyan(s.slug.padEnd(30))} ${status} ${fetched}`);
      console.log(`  ${" ".repeat(30)} ${chalk.dim(s.url)}`);
    }
  }

  if (isStub && stubFields.locations && stubFields.locations.length > 0) {
    console.log();
    console.log(chalk.bold("Declared locations:"));
    for (const loc of stubFields.locations) {
      const kind = LOCATOR_KEYS.find((key) => typeof loc[key] === "string");
      const target = kind ? loc[kind] : undefined;
      const canonicalLabel = loc.canonical ? `  ${chalk.green("canonical")}` : "";
      console.log(
        `  ${chalk.cyan((kind ?? "unknown").padEnd(9))}${target ?? chalk.dim("—")}${canonicalLabel}`,
      );
      if (loc.title) console.log(`  ${" ".repeat(9)}${chalk.dim(loc.title)}`);
    }
    console.log();
    console.log(chalk.dim(`  Enable tracking: releases admin org promote ${found.slug}`));
  }

  if (overview?.content) {
    const preview = overviewPreview(stripAnsi(overview.content));
    // Content write time (updatedAt), not original generatedAt — amends refresh
    // the body without resetting generation, so stale checks must follow the write.
    const stale = isOverviewContentStale(overview);
    const freshnessHint = formatOverviewFreshnessHint(overview);
    const generatedHint = freshnessHint ? chalk.dim(freshnessHint) : "";

    console.log();
    console.log(`${chalk.bold("Overview")}  ${generatedHint}`);
    if (stale) {
      console.log(
        chalk.yellow(
          `  ⚠ Overview is older than ${OVERVIEW_STALE_DAYS} days — may not reflect recent releases.`,
        ),
      );
    }
    console.log(preview);
    console.log(chalk.dim(`\n  Full overview: releases org overview ${found.slug}`));
  }
}

type OrgUpdateOpts = {
  name?: string;
  slug?: string;
  domain?: string;
  description?: string;
  category?: string | boolean;
  avatar?: string | boolean;
  paused?: boolean;
  featured?: boolean;
  autoGenerateContent?: boolean;
  overviewCadence?: string;
  discovery?: string;
  notice?: string;
  noticeLink?: string;
  noticeLinkText?: string;
  clearNotice?: boolean;
  json?: boolean;
  dryRun?: boolean;
};

async function orgUpdateAction(identifier: string, opts: OrgUpdateOpts): Promise<void> {
  // Validate enumerated options before any network call so errors surface fast.
  if (typeof opts.category === "string" && !isValidCategory(opts.category)) {
    logger.error(`Invalid category: "${opts.category}". Valid: ${CATEGORIES.join(", ")}`);
    process.exit(1);
  }
  if (
    opts.discovery !== undefined &&
    !(SOURCE_DISCOVERY as readonly string[]).includes(opts.discovery)
  ) {
    logger.error(`Invalid discovery "${opts.discovery}". Valid: ${SOURCE_DISCOVERY.join(", ")}`);
    process.exit(1);
  }
  // Overview regen cadence override (buildinternet/releases#1895): "auto"
  // clears back to the velocity-tiered automatic cadence; a number (1-90,
  // matching the API's validation range) pins a fixed cadence in days.
  let overviewCadenceDays: number | null | undefined;
  if (opts.overviewCadence !== undefined) {
    if (opts.overviewCadence.toLowerCase() === "auto") {
      overviewCadenceDays = null;
    } else {
      const n = Number(opts.overviewCadence);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        logger.error(
          `Invalid --overview-cadence "${opts.overviewCadence}". Use a whole number of days (1-90) or "auto".`,
        );
        process.exit(1);
      }
      overviewCadenceDays = n;
    }
  }

  const found = await findOrg(identifier);
  if (!found) return orgNotFound(identifier);

  const updates: Record<string, unknown> = {};
  if (opts.name !== undefined) updates.name = opts.name;
  if (opts.slug !== undefined) updates.slug = opts.slug;
  if (opts.domain !== undefined) updates.domain = opts.domain;
  if (opts.description !== undefined) updates.description = opts.description;

  if (opts.category === false) {
    updates.category = null;
  } else if (typeof opts.category === "string") {
    updates.category = opts.category;
  }

  if (opts.avatar === false) updates.avatarUrl = null;
  else if (typeof opts.avatar === "string") updates.avatarUrl = opts.avatar;

  if (opts.paused !== undefined) updates.fetchPaused = opts.paused;

  // Editorial home-page rail flag (buildinternet/releases#1274). The API field
  // is `featured`; commander surfaces --featured/--no-featured as a single
  // boolean (undefined when neither is passed).
  if (opts.featured !== undefined) updates.featured = opts.featured;

  // The single backend gate for both org overviews and per-release summaries
  // (buildinternet/releases#1794). Commander surfaces --auto-generate-content /
  // --no-auto-generate-content as one boolean (undefined when neither passed).
  if (opts.autoGenerateContent !== undefined)
    updates.autoGenerateContent = opts.autoGenerateContent;

  if (overviewCadenceDays !== undefined) updates.overviewCadenceDays = overviewCadenceDays;

  if (opts.discovery !== undefined) updates.discovery = opts.discovery;

  const noticePatch = buildNoticePatch(opts, logger);
  if (noticePatch !== null) updates.notice = noticePatch.notice;

  if (Object.keys(updates).length === 0) {
    logger.warn("No fields to update.");
    process.exit(1);
  }

  if (opts.dryRun) {
    if (opts.json)
      await writeJson(markDryRun({ wouldUpdate: found.slug, name: found.name, updates }));
    else {
      logger.warn(`[dry-run] Would update organization: ${found.name} (${found.slug})`);
      for (const [k, v] of Object.entries(updates))
        logger.warn(`  ${k} → ${v === null ? "(cleared)" : String(v)}`);
    }
    return;
  }

  const updated = await updateOrg(found.slug, updates);

  if (opts.json) await writeJson(updated);
  else {
    const pausedSuffix =
      opts.paused === true ? "  — paused" : opts.paused === false ? "  — unpaused" : "";
    const autoGenSuffix =
      opts.autoGenerateContent === true
        ? "  — AI content on"
        : opts.autoGenerateContent === false
          ? "  — AI content off"
          : "";
    const cadenceSuffix =
      overviewCadenceDays === null
        ? "  — overview cadence: automatic"
        : overviewCadenceDays !== undefined
          ? `  — overview cadence: every ${overviewCadenceDays}d`
          : "";
    logger.info(
      chalk.green(
        `Updated organization: ${updated.name} (${updated.slug})${pausedSuffix}${autoGenSuffix}${cadenceSuffix}`,
      ),
    );
  }
}

type OrgDeleteOpts = { json?: boolean; dryRun?: boolean; hard?: boolean; yes?: boolean };

// Defaults to a tombstone soft-delete (reversible). With --hard, the row is
// purged and the FK cascade also wipes every source, release, fetch_log,
// changelog file/chunk, release summary, media asset, and webhook
// subscription tied to the org (#690 Phase C). The command surfaces a
// typeback prompt before any cascade runs; --yes / -y bypasses it for
// scripted ops, and a piped (non-TTY) stdin without --yes errors out
// rather than silently confirming.
export async function orgDeleteAction(identifier: string, opts: OrgDeleteOpts): Promise<void> {
  // Fail fast on the obvious misconfiguration: --hard from a piped
  // stdin without --yes. Applies to --dry-run too — a scripted hard
  // delete that "works" in dry-run only to error in the real run is
  // a worse outcome than a single up-front complaint.
  if (opts.hard && !opts.yes && !process.stdin.isTTY) {
    logger.error(
      "No interactive TTY available — pass --yes to confirm a hard delete in scripted contexts.",
    );
    process.exit(1);
  }

  const found = await findOrg(identifier);
  if (!found) return orgNotFound(identifier);

  if (opts.dryRun) {
    if (opts.json)
      await writeJson(markDryRun({ wouldRemove: found.slug, name: found.name, hard: !!opts.hard }));
    else
      logger.warn(
        `[dry-run] Would ${opts.hard ? "hard-delete" : "delete"} organization: ${found.name} (${found.slug})`,
      );
    return;
  }

  if (opts.hard && !opts.yes) {
    let dependents;
    try {
      dependents = await getOrgDependents(found.slug);
    } catch (err) {
      logger.error(`Failed to load cascade preview: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const c = dependents.counts;
    console.error("");
    console.error(chalk.bold.red("This will permanently delete:"));
    console.error(`  - 1 organization (${found.name}, slug: ${found.slug})`);
    console.error(`  - ${c.sources.toLocaleString()} sources`);
    console.error(`  - ${c.releases.toLocaleString()} releases`);
    console.error(`  - ${c.sourceChangelogChunks.toLocaleString()} changelog chunks`);
    console.error(`  - ${c.sourceChangelogFiles.toLocaleString()} changelog files`);
    console.error(`  - ${c.fetchLog.toLocaleString()} fetch log entries`);
    console.error(`  - ${c.releaseSummaries.toLocaleString()} release summaries`);
    console.error(`  - ${c.mediaAssets.toLocaleString()} media assets`);
    console.error(`  - ${c.webhookSubscriptions.toLocaleString()} webhook subscriptions`);
    console.error("");
    console.error(chalk.red("This is irreversible."));

    const confirmed = await promptConfirm(`Type the org slug to confirm: `, found.slug);
    if (!confirmed) {
      logger.warn("Slug did not match. Aborted.");
      process.exit(1);
    }
  }

  // The server rejects a slug on the destructive hard-delete path (a guardrail
  // against accidental slug-based purges, per #690) — it requires the typed
  // org_ ID. Soft delete accepts either, so keep the slug for its friendlier
  // audit-log target.
  await removeOrg(opts.hard ? found.id : found.slug, { hard: opts.hard });

  if (opts.json) await writeJson({ removed: found.slug, hard: !!opts.hard });
  else
    logger.info(
      chalk.green(
        `${opts.hard ? "Hard-deleted" : "Deleted"} organization: ${found.name} (${found.slug})`,
      ),
    );
}

/**
 * Resolve a `--from` value to a concrete image URL. An https URL is used as-is;
 * the shortcuts derive a URL from the org's own data (no fuzzy matching): `github`
 * → the org's linked GitHub handle, `favicon` → the org domain's apple-touch-icon,
 * `appstore` → the org's App Store source's iTunes artwork (#1406).
 */
async function resolveAvatarSource(
  from: string,
  org: { id: string; slug: string; domain?: string | null },
): Promise<string> {
  if (/^https:\/\//i.test(from)) return from;
  if (/^http:\/\//i.test(from)) {
    throw new Error(
      `Refusing to fetch an avatar over plaintext http. Pass an https:// URL instead.`,
    );
  }
  switch (from) {
    case "github": {
      const accounts = await getOrgAccountsBySlug(org.slug);
      const gh = accounts.find((a) => a.platform === "github");
      if (!gh)
        throw new Error(`No GitHub account linked to ${org.slug}; pass --from <url> instead.`);
      return githubAvatarUrl(gh.handle);
    }
    case "favicon": {
      if (!org.domain) throw new Error(`${org.slug} has no domain; pass --from <url> instead.`);
      return faviconAvatarUrl(org.domain);
    }
    case "appstore": {
      const sources = await getSourcesByOrg(org.id);
      const app = sources.find((s) => s.type === "appstore" && s.url);
      if (!app?.url)
        throw new Error(
          `${org.slug} has no App Store source; pass the apps.apple.com artwork URL via --from <url>.`,
        );
      const trackId = appStoreTrackId(app.url);
      if (!trackId) throw new Error(`Could not parse an App Store track id from ${app.url}.`);
      const art = await appStoreArtworkUrl(trackId);
      if (!art) throw new Error(`iTunes lookup returned no artwork for track ${trackId}.`);
      return art;
    }
    default:
      throw new Error(
        `Unknown --from "${from}". Use an https:// URL, or appstore | github | favicon.`,
      );
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerOrgCommand(program: Command) {
  const org = program.command("org").description("Manage organizations");

  // Stub-tier verbs — create-stub / create-stub-from-domain / promote (#1947)
  registerOrgStubCommands(org);

  // ── org create (canonical) / org add (deprecated) ──
  org
    .command("create")
    .description("Create a new organization")
    .argument("<name>", "Organization name")
    .option("--domain <domain>", "Primary domain")
    .option("--slug <slug>", "Custom slug")
    .option("--description <text>", "Brief product description")
    .option("--category <category>", "Category")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output as JSON")
    .option("--strict", "Exit 1 if the organization already exists (default: return existing)")
    .option("--dry-run", "Show what would be created without writing")
    .action(orgCreateAction);

  org
    .command("add")
    .description("(deprecated — use create) Add a new organization")
    .argument("<name>", "Organization name")
    .option("--domain <domain>", "Primary domain")
    .option("--slug <slug>", "Custom slug")
    .option("--description <text>", "Brief product description")
    .option("--category <category>", "Category")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--json", "Output as JSON")
    .option("--strict", "Exit 1 if the organization already exists (default: return existing)")
    .option("--dry-run", "Show what would be created without writing")
    .action(warnDeprecatedAlias<[string, OrgCreateOpts]>("add", "create", orgCreateAction));

  // ── org list ──
  org
    .command("list")
    .description("List all organizations")
    .option("--query <text>", "Filter by name, slug, domain, handle, or org_ id")
    .option("--platform <platform>", "Filter to orgs with an account on this platform")
    .option("--include-empty", "Include orgs with zero indexed releases (curator stubs)")
    .option("--json", "Output as JSON")
    .option("--limit <n>", `Limit the number of results (default ${DEFAULT_PAGE_SIZE})`)
    .option("--page <n>", "Page number for paginated results")
    .option(
      "--page-all",
      "Stream every page as newline-delimited JSON (one org per line, --json only)",
    )
    .action(
      async (opts: {
        query?: string;
        platform?: string;
        includeEmpty?: boolean;
        json?: boolean;
        limit?: string;
        page?: string;
        pageAll?: boolean;
      }) => {
        const parsedLimit = opts.limit === undefined ? undefined : Number(opts.limit);
        if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
          logger.error("--limit must be a positive integer");
          process.exit(1);
        }
        const explicitLimit = parsedLimit !== undefined;
        const pageSize = explicitLimit ? parsedLimit : DEFAULT_PAGE_SIZE;

        const parsedPage = opts.page === undefined ? 1 : Number(opts.page);
        if (!Number.isInteger(parsedPage) || parsedPage <= 0) {
          logger.error("--page must be a positive integer");
          process.exit(1);
        }
        const page = parsedPage;

        // --page-all: stream every page as NDJSON (one org per line). Returns
        // true only when it handled the request (--json); otherwise falls through.
        if (
          await handlePageAll(opts, async (p) => {
            const { items, pagination } = await listOrgs({
              query: opts.query,
              platform: opts.platform,
              includeEmpty: opts.includeEmpty,
              limit: pageSize,
              page: p,
            });
            return { items, hasMore: pagination.hasMore };
          })
        )
          return;

        const { items: pageItems, pagination } = await listOrgs({
          query: opts.query,
          platform: opts.platform,
          includeEmpty: opts.includeEmpty,
          limit: pageSize,
          page,
        });

        if (pageItems.length === 0) {
          if (opts.json) {
            const response: ListResponse<(typeof pageItems)[number]> = { items: [], pagination };
            await writeJson(response);
          } else {
            logger.info(chalk.yellow("No organizations found."));
          }
          return;
        }

        if (opts.json) {
          const response: ListResponse<(typeof pageItems)[number]> = {
            items: pageItems,
            pagination,
          };
          await writeJson(response);
          if (!explicitLimit && pagination.hasMore) {
            logger.warn(
              formatTruncationWarning({
                returned: pageItems.length,
                pageSize,
                commandExample: `releases org list --json --limit <n> --page <p>`,
              }),
            );
          }
          return;
        }

        console.log(
          renderTable({
            head: [
              { label: "Name" },
              { label: "Slug", noTruncate: true },
              { label: "Domain" },
              { label: "Updated", noTruncate: true },
            ],
            rows: pageItems.map((o) => [o.name, o.slug, o.domain ?? chalk.dim("—"), o.updatedAt]),
          }),
        );
        if (!explicitLimit && pagination.hasMore) {
          logger.warn(
            formatTruncationWarning({
              returned: pageItems.length,
              pageSize,
              commandExample: `releases org list --limit <n> --page <p>`,
            }),
          );
        }
      },
    );

  // ── org get (canonical) / org show (deprecated) ──
  org
    .command("get")
    .description("Get organization details")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .action(orgGetAction);

  org
    .command("show")
    .description("(deprecated — use get) Show organization details")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .action(warnDeprecatedAlias<[string, OrgGetOpts]>("show", "get", orgGetAction));

  // ── org overview ──
  org
    .command("overview")
    .description("Print the full AI-generated overview for an organization")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, name, or account handle")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases org overview acme
  releases org overview acme --json`,
    )
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const overview = await getOverview("org", found.slug).catch(() => null);

      if (!overview?.content) {
        if (opts.json) {
          await writeJson({ org: found.slug, overview: null });
        } else {
          console.log(chalk.yellow(`No overview available for ${found.name}.`));
        }
        return;
      }

      // Prefer updatedAt for age/stale: generatedAt is fixed at first write and
      // stays old after amends (e.g. generated 3mo ago, updated 4d ago).
      const stale = isOverviewContentStale(overview);
      const ageDays = overviewContentAgeDays(overview);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              org: found.slug,
              name: found.name,
              generatedAt: overview.generatedAt,
              updatedAt: overview.updatedAt,
              lastContributingReleaseAt: overview.lastContributingReleaseAt,
              releaseCount: overview.releaseCount,
              stale,
              ageDays,
              content: overview.content,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(chalk.bold(`${found.name} — overview`));
      console.log(chalk.dim(`  ${formatOverviewFreshnessLine(overview)}`));
      if (stale) {
        console.log(
          chalk.yellow(
            `  ⚠ Overview is older than ${OVERVIEW_STALE_DAYS} days — may not reflect recent releases.`,
          ),
        );
      }
      console.log();
      console.log(stripAnsi(overview.content));
    });

  // ── org update (canonical) / org edit (deprecated) ──
  org
    .command("update")
    .description("Update an organization")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, or name")
    .option("--name <name>", "Update display name")
    .option("--slug <slug>", "Update slug")
    .option("--domain <domain>", "Update domain")
    .option("--description <text>", "Update description")
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
    .option("--avatar <url>", "Set avatar image URL")
    .option("--no-avatar", "Clear avatar URL")
    .option("--paused", "Pause ingest for all of this org's sources (catalog stays visible)")
    .option("--no-paused", "Resume ingest for this org's sources")
    .option("--featured", "Promote this org on the home-page featured rail")
    .option("--no-featured", "Remove this org from the home-page featured rail")
    .option(
      "--auto-generate-content",
      "Opt this org into automatic AI content (overviews + per-release summaries)",
    )
    .option(
      "--no-auto-generate-content",
      "Opt this org out of automatic AI content (overviews + per-release summaries)",
    )
    .option(
      "--overview-cadence <days|auto>",
      'Pin the automated overview regen cadence in days (1-90), or "auto" for the velocity-tiered default',
    )
    .option(
      "--discovery <status>",
      `Promote/demote discovery status (${SOURCE_DISCOVERY.join(" | ")})`,
    )
    .option("--notice <message>", "Set a curator notice on this organization (max 280 chars)")
    .option(
      "--notice-link <coordinate|url>",
      "Optional pointer: registry coordinate (org/slug) or https:// URL",
    )
    .option(
      "--notice-link-text <label>",
      "Optional link label for the notice pointer (max 60 chars)",
    )
    .option("--clear-notice", "Remove the notice from this organization")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing")
    .action(orgUpdateAction);

  org
    .command("avatar")
    .description("Resolve an image, mirror it to R2, and set it as the org avatar")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, or name")
    .requiredOption(
      "--from <source>",
      "Image source: an https:// URL, or a shortcut — appstore | github | favicon",
    )
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { from: string; json?: boolean }) => {
      const target = await findOrg(identifier);
      if (!target) {
        return orgNotFound(identifier);
      }

      let sourceUrl: string;
      try {
        sourceUrl = await resolveAvatarSource(opts.from.trim(), target);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      try {
        const result = await setOrgAvatar(target.slug, sourceUrl);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        logger.info(
          `${chalk.green("✓")} Set ${chalk.bold(target.slug)} avatar → ${result.avatarUrl} (${result.width}×${result.height})`,
        );
      } catch (err) {
        logger.error(`Failed to set avatar: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  org
    .command("edit")
    .description("(deprecated — use update) Edit an organization")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, or name")
    .option("--name <name>", "Update display name")
    .option("--slug <slug>", "Update slug")
    .option("--domain <domain>", "Update domain")
    .option("--description <text>", "Update description")
    .option("--category <category>", "Set category")
    .option("--no-category", "Clear category")
    .option("--avatar <url>", "Set avatar image URL")
    .option("--no-avatar", "Clear avatar URL")
    .option("--paused", "Pause ingest for all of this org's sources (catalog stays visible)")
    .option("--no-paused", "Resume ingest for this org's sources")
    .option("--featured", "Promote this org on the home-page featured rail")
    .option("--no-featured", "Remove this org from the home-page featured rail")
    .option(
      "--auto-generate-content",
      "Opt this org into automatic AI content (overviews + per-release summaries)",
    )
    .option(
      "--no-auto-generate-content",
      "Opt this org out of automatic AI content (overviews + per-release summaries)",
    )
    .option(
      "--overview-cadence <days|auto>",
      'Pin the automated overview regen cadence in days (1-90), or "auto" for the velocity-tiered default',
    )
    .option(
      "--discovery <status>",
      `Promote/demote discovery status (${SOURCE_DISCOVERY.join(" | ")})`,
    )
    .option("--notice <message>", "Set a curator notice on this organization (max 280 chars)")
    .option(
      "--notice-link <coordinate|url>",
      "Optional pointer: registry coordinate (org/slug) or https:// URL",
    )
    .option(
      "--notice-link-text <label>",
      "Optional link label for the notice pointer (max 60 chars)",
    )
    .option("--clear-notice", "Remove the notice from this organization")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing")
    .action(warnDeprecatedAlias<[string, OrgUpdateOpts]>("edit", "update", orgUpdateAction));

  // ── org delete (canonical) / org remove (deprecated) ──
  org
    .command("delete")
    .description("Delete an organization (soft-delete by default; --hard purges with cascade)")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, name, or handle")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--hard", "Permanently delete the org and cascade-delete all dependent rows")
    .option("-y, --yes", "Skip the confirmation prompt (required for non-interactive --hard)")
    .option("--json", "Output as JSON")
    .action(orgDeleteAction);

  org
    .command("remove")
    .description("(deprecated — use delete) Remove an organization")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, name, or handle")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--hard", "Permanently delete the org and cascade-delete all dependent rows")
    .option("-y, --yes", "Skip the confirmation prompt (required for non-interactive --hard)")
    .option("--json", "Output as JSON")
    .action(warnDeprecatedAlias<[string, OrgDeleteOpts]>("remove", "delete", orgDeleteAction));

  // ── org link ──
  org
    .command("link")
    .description("Link a platform account to an organization")
    .argument("<identifier>", "Organization ID (org_…), slug, domain, name, or handle")
    .requiredOption("--platform <platform>", "Platform name (github, x, etc.)")
    .requiredOption("--handle <handle>", "Account handle on the platform")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be linked without writing")
    .action(
      async (
        identifier: string,
        opts: { platform: string; handle: string; json?: boolean; dryRun?: boolean },
      ) => {
        const found = await findOrg(identifier);
        if (!found) return orgNotFound(identifier);

        if (opts.dryRun) {
          if (opts.json)
            await writeJson(
              markDryRun({
                wouldLink: { platform: opts.platform, handle: opts.handle },
                org: found.slug,
              }),
            );
          else
            console.log(
              chalk.yellow(`[dry-run] Would link ${opts.platform}/${opts.handle} to ${found.name}`),
            );
          return;
        }

        const created = await linkOrgAccount(found.slug, opts.platform, opts.handle);

        if (opts.json) await writeJson(created);
        else console.log(chalk.green(`Linked ${opts.platform}/${opts.handle} to ${found.name}`));
      },
    );

  // ── org unlink ──
  org
    .command("unlink")
    .description("Remove a platform account from an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .requiredOption("--platform <platform>", "Platform name")
    .requiredOption("--handle <handle>", "Account handle")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would be unlinked without writing")
    .action(
      async (
        identifier: string,
        opts: { platform: string; handle: string; json?: boolean; dryRun?: boolean },
      ) => {
        const found = await findOrg(identifier);
        if (!found) return orgNotFound(identifier);

        if (opts.dryRun) {
          if (opts.json)
            await writeJson(
              markDryRun({
                wouldUnlink: { platform: opts.platform, handle: opts.handle },
                org: found.slug,
              }),
            );
          else
            console.log(
              chalk.yellow(
                `[dry-run] Would unlink ${opts.platform}/${opts.handle} from ${found.name}`,
              ),
            );
          return;
        }

        await unlinkOrgAccount(found.slug, opts.platform, opts.handle);

        if (opts.json) await writeJson({ unlinked: `${opts.platform}/${opts.handle}` });
        else
          console.log(chalk.green(`Unlinked ${opts.platform}/${opts.handle} from ${found.name}`));
      },
    );

  // ── org tag — membership verbs (add/remove) stay unchanged ──
  const tag = org.command("tag").description("Manage organization tags");

  tag
    .command("add")
    .description("Add tags to an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .argument("<tags...>", "Tag names to add")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, tagNames: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);
      await addTagsToOrg(found.id, tagNames);
      if (opts.json) {
        const allTags = await getTagsForOrg(found.id);
        await writeJson({ tags: allTags });
      } else {
        console.log(chalk.green(`Added tags to ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("remove")
    .description("Remove tags from an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .argument("<tags...>", "Tag names to remove")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, tagNames: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);
      await removeTagsFromOrg(found.id, tagNames);
      if (opts.json) {
        const allTags = await getTagsForOrg(found.id);
        await writeJson({ tags: allTags });
      } else {
        console.log(chalk.green(`Removed tags from ${found.name}: ${tagNames.join(", ")}`));
      }
    });

  tag
    .command("list")
    .description("List tags for an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);
      const allTags = await getTagsForOrg(found.id);
      if (opts.json) await writeJson(allTags);
      else if (allTags.length === 0) console.log(chalk.yellow(`No tags for ${found.name}`));
      else console.log(allTags.join(", "));
    });

  // ── org alias — membership verbs (add/remove) stay unchanged ──
  const alias = org.command("alias").description("Manage domain aliases for an organization");

  alias
    .command("add")
    .description("Add domain aliases to an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .argument("<domains...>", "Domain names to add")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const current = await getAliases("org", found.slug);
      const currentSet = new Set(current);
      const added: string[] = [];
      for (const d of domains) {
        if (!currentSet.has(d)) {
          currentSet.add(d);
          added.push(d);
        }
      }
      if (added.length > 0) {
        try {
          await setAliases("org", found.slug, [...currentSet]);
        } catch (err) {
          logger.error(
            chalk.red(`Failed to add aliases: ${err instanceof Error ? err.message : err}`),
          );
          return;
        }
      }

      if (opts.json) await writeJson({ added });
      else for (const d of added) console.log(chalk.green(`Added alias: ${d} → ${found.name}`));
    });

  alias
    .command("remove")
    .description("Remove domain aliases from an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .argument("<domains...>", "Domain names to remove")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, domains: string[], opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const current = await getAliases("org", found.slug);
      const currentSet = new Set(current);
      const removed: string[] = [];
      for (const d of domains) {
        if (currentSet.delete(d)) removed.push(d);
        else console.error(chalk.yellow(`Alias "${d}" not found.`));
      }
      if (removed.length > 0) await setAliases("org", found.slug, [...currentSet]);

      if (opts.json) await writeJson({ removed });
      else for (const d of removed) console.log(chalk.green(`Removed alias: ${d}`));
    });

  alias
    .command("list")
    .description("List domain aliases for an organization")
    .argument("<identifier>", "Organization ID (org_…) or slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, opts: { json?: boolean }) => {
      const found = await findOrg(identifier);
      if (!found) return orgNotFound(identifier);

      const aliases = await getAliases("org", found.slug);

      if (opts.json) {
        const response: ListResponse<string> = {
          items: aliases,
          pagination: computePagination({
            page: 1,
            pageSize: aliases.length,
            returned: aliases.length,
            totalItems: aliases.length,
          }),
        };
        await writeJson(response);
      } else if (aliases.length === 0)
        console.log(chalk.yellow(`No domain aliases for ${found.name}`));
      else for (const d of aliases) console.log(d);
    });
}
