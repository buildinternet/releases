/**
 * Overview admin commands. Canonical surface mirrors the verb-rename pattern
 * (PR #113) — `overview list/get/update/inputs/plan` are subcommands under
 * `admin overview`. The legacy kebab-case names (`overview-list`,
 * `overview-write`, `overview-inputs`, and the bare `overview <slug>` read
 * form) are wired as deprecated aliases that warn-and-delegate.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { renderTable, type ColumnSpec } from "../../render/table.js";
import { findOrg, listOrgs } from "../../../api/orgs.js";
import {
  getOverview,
  getOverviewInputs,
  getOverviewInputsCheck,
  getOverviewManifest,
  upsertOverview,
  type OverviewInputs,
} from "../../../api/sources.js";
import { type OverviewCitation, type OverviewManifestRow } from "../../../api/types.js";
import { orgNotFound } from "../../suggest.js";
import { writeJson } from "../../../lib/output.js";
import {
  MAX_CONTENT_CHARS_DEFAULT,
  parseMaxContentCharsFlag,
  parsePositiveIntFlag,
} from "../../../lib/flags.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { timeAgo } from "@buildinternet/releases-core/dates";
import {
  filterStaleOrgs,
  STALE_MIN_RELEASES_DEFAULT,
  STALE_GRACE_DAYS_DEFAULT,
  type OrgWithOverview,
} from "../../../lib/overview-stale-filter.js";
import { formatOverviewFreshnessLine } from "../../../lib/overview-freshness.js";
import type { OrgListItem } from "@buildinternet/releases-api-types";
import { computePagination } from "@buildinternet/releases-core/cli-contracts";
import { unescapeHtmlEntities } from "./overview/unescape-html.js";
import { parseCitationsJson, ParseCitationsError } from "./overview/parse-citations.js";
import { readContentArg } from "../../../lib/input.js";
import { warnDeprecatedAlias } from "../../../lib/deprecated-alias.js";

// Re-export for callers/tests that imported the helper from this command module.
export { formatOverviewFreshnessLine } from "../../../lib/overview-freshness.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OverviewListOpts {
  json?: boolean;
  query?: string;
  // Server-side manifest filters (preferred — single round trip)
  staleDays?: string;
  missing?: boolean;
  hasActivity?: boolean;
  // Legacy client-side staleness filter (kept for back-compat)
  stale?: boolean;
  staleMinReleases?: string;
  staleGraceDays?: string;
}

interface OverviewGetOpts {
  json?: boolean;
}

interface OverviewUpdateOpts {
  contentFile: string;
  citationsFile?: string;
  releaseCount?: string;
  lastContributingAt?: string;
  unescapeHtml?: boolean;
  json?: boolean;
}

interface OverviewInputsOpts {
  json?: boolean;
  window?: string;
  limit?: string;
  check?: boolean;
  // `[n]` optional value: string when given, `true` when passed bare.
  maxContentChars?: string | boolean;
}

interface OverviewPlanOpts {
  json?: boolean;
  staleDays?: string;
  missing?: boolean;
  hasActivity?: boolean;
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function overviewGetAction(orgIdentifier: string, opts: OverviewGetOpts): Promise<void> {
  const org = await findOrg(orgIdentifier);
  if (!org) return orgNotFound(orgIdentifier);

  const overview = await getOverview("org", org.slug);
  if (!overview) {
    if (opts.json) {
      await writeJson({ org: org.slug, overview: null });
    } else {
      console.log(chalk.yellow(`No overview available for ${org.name}.`));
    }
    return;
  }

  // Citations are attached by the org overview GET, ordered by character
  // position (#228). Surface a count so a post-write `overview get` can verify
  // what `overview update` reported (it echoes `citations: N`); --json carries
  // the full array for round-trip/audit without a re-write.
  const citations = overview.citations ?? [];

  if (opts.json) {
    await writeJson({
      org: org.slug,
      content: overview.content,
      releaseCount: overview.releaseCount,
      generatedAt: overview.generatedAt,
      updatedAt: overview.updatedAt,
      lastContributingReleaseAt: overview.lastContributingReleaseAt,
      citationCount: citations.length,
      citations,
    });
    return;
  }

  console.log(chalk.bold(`${org.name} — overview`));
  console.log(
    chalk.dim(`  ${formatOverviewFreshnessLine({ ...overview, citationCount: citations.length })}`),
  );
  console.log();
  console.log(overview.content);
}

async function overviewUpdateAction(
  orgIdentifier: string,
  opts: OverviewUpdateOpts,
): Promise<void> {
  const org = await findOrg(orgIdentifier);
  if (!org) return orgNotFound(orgIdentifier);

  // Always decode the five entities sub-agents reflexively over-escape when
  // relaying markdown (Q&amp;A, streams.input&lt;T&gt;) — a transport artifact,
  // not authored content (#229). The API stores `content` verbatim, so an
  // un-decoded entity would render wrong. Single-pass + idempotent, so a body
  // that's already clean (e.g. a caller that pre-decoded and computed citation
  // offsets against the decoded text) is unchanged and its offsets stay valid.
  // The `--unescapeHtml` flag is now the default; kept as an accepted no-op.
  let content = unescapeHtmlEntities(await readContentArg(opts.contentFile));
  if (!content.trim()) {
    logger.error("Content is empty — refusing to write.");
    process.exit(2);
  }

  let citations: OverviewCitation[] | undefined;
  if (opts.citationsFile !== undefined) {
    const raw = await readContentArg(opts.citationsFile);
    try {
      citations = parseCitationsJson(raw, opts.citationsFile);
    } catch (err) {
      if (err instanceof ParseCitationsError) {
        logger.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  let releaseCount = parsePositiveIntFlag("release-count", opts.releaseCount);
  let lastContributingAt = opts.lastContributingAt;

  if (releaseCount === undefined || lastContributingAt === undefined) {
    const inputs = await getOverviewInputs(org.slug);
    releaseCount ??= inputs?.totalAvailable ?? 0;
    lastContributingAt ??= inputs?.selected[0]?.publishedAt ?? undefined;
  }

  await upsertOverview(org.slug, {
    content,
    releaseCount,
    lastContributingReleaseAt: lastContributingAt ?? null,
    citations,
  });

  if (opts.json) {
    await writeJson({
      org: org.slug,
      chars: content.length,
      releaseCount,
      lastContributingReleaseAt: lastContributingAt ?? null,
      citations: citations?.length ?? 0,
    });
  } else {
    const citationsLabel = citations ? `, ${citations.length} citations` : "";
    logger.info(
      `Overview written for ${org.name}: ${content.length} chars, ${releaseCount} releases${citationsLabel}.`,
    );
  }
}

/**
 * Clip each `selected[].content` to at most `maxContentChars` characters,
 * client-side, before the payload is printed. The CLI already received the full
 * content over the wire — the wire isn't subject to the agent Bash-stdout cap;
 * only stdout is — so this is purely about keeping the printed JSON under that
 * cap for sub-agent callers. Never drops a release and leaves every other field
 * (including `existingContent`, `media`, `totalAvailable`) untouched. Returns
 * the input unchanged when `maxContentChars` is `undefined`.
 */
export function clipInputsContent(
  inputs: OverviewInputs,
  maxContentChars: number | undefined,
): OverviewInputs {
  if (maxContentChars === undefined) return inputs;
  return {
    ...inputs,
    selected: inputs.selected.map((r) =>
      r.content.length > maxContentChars
        ? { ...r, content: r.content.slice(0, maxContentChars) }
        : r,
    ),
  };
}

async function overviewInputsAction(
  orgIdentifier: string,
  opts: OverviewInputsOpts,
): Promise<void> {
  const org = await findOrg(orgIdentifier);
  if (!org) return orgNotFound(orgIdentifier);

  const window = parsePositiveIntFlag("window", opts.window);
  const limit = parsePositiveIntFlag("limit", opts.limit);
  const maxContentChars = parseMaxContentCharsFlag(opts.maxContentChars);

  if (opts.check) {
    const result = await getOverviewInputsCheck(org.slug, { window, limit });
    if (!result) {
      if (opts.json) {
        await writeJson({ error: "not_found", orgSlug: org.slug });
      } else {
        logger.error(
          `${org.name} exists in the registry but does not support overview generation (on_demand orgs are not eligible).`,
        );
      }
      process.exit(1);
    }
    if (opts.json) {
      await writeJson(result);
      return;
    }
    console.log(chalk.bold(`${org.name} — overview inputs (check)`));
    console.log(
      chalk.dim(
        `  selected ${result.selected} of ${result.totalAvailable} · window ${result.windowDays}d · existing: ${result.hasExistingContent ? "yes" : "no"}`,
      ),
    );
    console.log(
      result.wouldRegenerate
        ? chalk.green("  wouldRegenerate: true")
        : chalk.yellow("  wouldRegenerate: false"),
    );
    return;
  }

  const inputs = await getOverviewInputs(org.slug, { window, limit });
  if (!inputs) {
    if (opts.json) {
      await writeJson({ error: "not_found", orgSlug: org.slug });
    } else {
      logger.error(
        `${org.name} exists in the registry but does not support overview generation (on_demand orgs are not eligible).`,
      );
    }
    process.exit(1);
  }

  if (opts.json) {
    await writeJson(clipInputsContent(inputs, maxContentChars));
    return;
  }

  console.log(chalk.bold(`${inputs.org.name} — overview inputs`));
  console.log(
    chalk.dim(
      `  window: ${inputs.windowDays}d · sources: ${inputs.sources.length} · selected: ${inputs.selected.length} of ${inputs.totalAvailable}`,
    ),
  );
  console.log();
  if (inputs.existingContent) {
    console.log(chalk.dim("Existing overview present (will be passed for amend-and-evolve)."));
  } else {
    console.log(chalk.dim("No existing overview — first generation."));
  }
  if (inputs.selected.length === 0) {
    console.log();
    console.log(chalk.yellow("No releases in window. Skip generation; nothing to write."));
    return;
  }
  console.log();
  console.log(chalk.dim("Selected releases (most recent first):"));
  for (const r of inputs.selected.slice(0, 10)) {
    const v = r.version ? ` ${r.version}` : "";
    const t = r.title ? ` — ${r.title}` : "";
    console.log(`  ${r.publishedAt ?? "—"}${v}${t}`);
  }
  if (inputs.selected.length > 10) {
    console.log(chalk.dim(`  … ${inputs.selected.length - 10} more (use --json for full list)`));
  }
}

/**
 * Server-side manifest path. Used when any of `staleDays/missing/hasActivity`
 * is set, or for `overview plan` mode (which always sets `format=plan`).
 */
async function fetchManifest(opts: {
  staleDays?: number;
  missing?: boolean;
  hasActivity?: boolean;
  plan?: boolean;
}): Promise<OverviewManifestRow[]> {
  // Manifest is small (one row per org). Pull every page so consumers don't
  // have to. The pagination envelope is the standard `{items, pagination}`.
  const all: OverviewManifestRow[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    // eslint-disable-next-line no-await-in-loop
    const res = await getOverviewManifest({ ...opts, page, limit: 200 });
    all.push(...res.items);
    hasMore = res.pagination.hasMore;
    page += 1;
  }
  return all;
}

function stalenessLabel(staleness: OverviewManifestRow["staleness"]): string {
  switch (staleness) {
    case "missing":
      return chalk.yellow("missing");
    case "behind":
      return chalk.red("behind");
    default:
      return chalk.green("fresh");
  }
}

function timeAgoOrDim(iso: string | null | undefined): string {
  if (!iso) return chalk.dim("—");
  return timeAgo(iso) ?? iso;
}

function renderManifestTable(rows: OverviewManifestRow[], plan: boolean): void {
  const head: ColumnSpec[] = [
    { label: "Org", noTruncate: true },
    { label: "Staleness", noTruncate: true },
    { label: "Recent", noTruncate: true, alignRight: true },
    { label: "Behind", noTruncate: true, alignRight: true },
    { label: "Last Activity", noTruncate: true },
    { label: "Overview Updated", noTruncate: true },
  ];
  if (plan) {
    head.push({ label: "Action" }, { label: "Fetch?", noTruncate: true });
  }

  console.log(
    renderTable({
      head,
      rows: rows.map((r) => {
        const base = [
          r.orgSlug,
          stalenessLabel(r.staleness),
          String(r.recentReleaseCount),
          String(r.releasesSinceOverview),
          timeAgoOrDim(r.orgLastActivity),
          timeAgoOrDim(r.overviewUpdatedAt),
        ];
        if (!plan) return base;
        return [...base, r.action ?? "", r.needsFetch ? chalk.yellow("yes") : chalk.dim("no")];
      }),
    }),
  );
}

async function overviewListAction(opts: OverviewListOpts): Promise<void> {
  const useManifest =
    opts.staleDays !== undefined || opts.missing === true || opts.hasActivity === true;

  if (useManifest) {
    const staleDays = parsePositiveIntFlag("stale-days", opts.staleDays);
    const rows = await fetchManifest({
      staleDays,
      missing: opts.missing,
      hasActivity: opts.hasActivity,
    });

    // Optional client-side query filter (api manifest doesn't take ?query yet).
    const filtered = opts.query
      ? rows.filter((r) => {
          const q = opts.query!.toLowerCase();
          return r.orgSlug.toLowerCase().includes(q) || r.orgName.toLowerCase().includes(q);
        })
      : rows;

    if (opts.json) {
      await writeJson({
        items: filtered,
        pagination: computePagination({
          page: 1,
          pageSize: filtered.length,
          returned: filtered.length,
          totalItems: filtered.length,
        }),
      });
      return;
    }
    if (filtered.length === 0) {
      console.log(chalk.green("No matching overviews."));
      return;
    }
    renderManifestTable(filtered, false);
    console.log(chalk.dim(`\n${filtered.length} org(s)`));
    return;
  }

  // Legacy client-side path — kept for the back-compat `--stale` flag and the
  // bare `overview list` invocation. Pulls every page through the org list,
  // attaches each overview, applies the legacy staleness predicate.
  const minReleases = parsePositiveIntFlag("stale-min-releases", opts.staleMinReleases);
  const graceDays = parsePositiveIntFlag("stale-grace-days", opts.staleGraceDays);

  const orgs: OrgListItem[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    // eslint-disable-next-line no-await-in-loop
    const result = await listOrgs({ query: opts.query, page, limit: 200 });
    orgs.push(...(result.items as unknown as OrgListItem[]));
    hasMore = result.pagination.hasMore;
    page += 1;
  }

  if (orgs.length === 0) {
    if (opts.json)
      await writeJson({
        items: [],
        pagination: computePagination({ page: 1, pageSize: 0, returned: 0, totalItems: 0 }),
      });
    else console.log(chalk.yellow("No organizations found."));
    return;
  }

  let candidates: OrgWithOverview[];

  if (opts.stale) {
    const threshold = minReleases ?? STALE_MIN_RELEASES_DEFAULT;
    const active = orgs.filter((o) => o.recentReleaseCount > threshold);

    const withOverviews: OrgWithOverview[] = await Promise.all(
      active.map(async (o) => {
        const ov = await getOverview("org", o.slug).catch(() => null);
        const entry = o as OrgWithOverview;
        entry.overview = ov ?? undefined;
        return entry;
      }),
    );

    candidates = filterStaleOrgs(withOverviews, { minReleases, graceDays });
  } else {
    candidates = orgs as OrgWithOverview[];
  }

  if (candidates.length === 0) {
    if (opts.json)
      await writeJson({
        items: [],
        pagination: computePagination({ page: 1, pageSize: 0, returned: 0, totalItems: 0 }),
      });
    else console.log(chalk.green("No stale overviews found."));
    return;
  }

  if (opts.json) {
    const items = candidates.map((o) => ({
      slug: o.slug,
      name: o.name,
      recentReleaseCount: o.recentReleaseCount,
      lastActivity: o.lastActivity,
      overviewUpdatedAt: o.overview?.updatedAt ?? null,
      overviewMissing: !o.overview,
    }));
    await writeJson({
      items,
      pagination: computePagination({
        page: 1,
        pageSize: items.length,
        returned: items.length,
        totalItems: items.length,
      }),
    });
    return;
  }

  console.log(
    renderTable({
      head: [
        { label: "Org", noTruncate: true },
        { label: "Recent", noTruncate: true, alignRight: true },
        { label: "Last Activity", noTruncate: true },
        { label: "Overview Updated", noTruncate: true },
      ],
      rows: candidates.map((o) => [
        o.slug,
        String(o.recentReleaseCount),
        timeAgoOrDim(o.lastActivity),
        o.overview?.updatedAt
          ? (timeAgo(o.overview.updatedAt) ?? o.overview.updatedAt)
          : chalk.yellow("missing"),
      ]),
    }),
  );
  if (opts.stale) {
    console.log(
      chalk.dim(
        `\n${candidates.length} org(s) with stale overviews (minReleases=${minReleases ?? STALE_MIN_RELEASES_DEFAULT}, graceDays=${graceDays ?? STALE_GRACE_DAYS_DEFAULT})`,
      ),
    );
  }
}

async function overviewPlanAction(opts: OverviewPlanOpts): Promise<void> {
  const staleDays = parsePositiveIntFlag("stale-days", opts.staleDays);
  const rows = await fetchManifest({
    staleDays,
    missing: opts.missing,
    hasActivity: opts.hasActivity,
    plan: true,
  });

  if (opts.json) {
    await writeJson({
      items: rows,
      pagination: computePagination({
        page: 1,
        pageSize: rows.length,
        returned: rows.length,
        totalItems: rows.length,
      }),
    });
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.green("Nothing to plan — no orgs match the filter."));
    return;
  }

  renderManifestTable(rows, true);

  // Group counts by action for the orchestrator's summary.
  const byAction = rows.reduce<Record<string, number>>((acc, r) => {
    if (r.action) acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  // `opted_out` = autoGenerateContent is off, so the batch skips the org
  // regardless of staleness (buildinternet/releases#1795). Surfaced here so it
  // isn't silently absent from the tally.
  const parts = ["missing", "refresh", "skip", "opted_out"]
    .map((a) => `${a}: ${byAction[a] ?? 0}`)
    .join(" · ");
  console.log(chalk.dim(`\n${rows.length} org(s) — ${parts}`));
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerOverviewCommands(admin: Command): void {
  // Canonical subcommand group. Subcommands resolve normally; if the bare
  // `admin overview <slug>` form is invoked (deprecated), commander falls
  // through to the group's default action below.
  const overview = admin.command("overview").description("Manage org overviews");

  // Bare `overview <org>` is the legacy read form. Keep it working with a
  // deprecation warning that points at `overview get <org>`.
  overview
    .argument("[org]", "Organization slug or ID (deprecated; use 'overview get <org>')")
    .option("--json", "Output as JSON")
    .action((arg: string | undefined, opts: OverviewGetOpts) => {
      if (!arg) {
        overview.help();
        return;
      }
      logger.warn('"overview <org>" is deprecated, use "overview get <org>"');
      return overviewGetAction(arg, opts);
    });

  overview
    .command("get")
    .description("Read an organization's AI overview")
    .argument("<org>", "Organization slug or ID")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin overview get vercel
  releases admin overview get vercel --json`,
    )
    .action(overviewGetAction);

  overview
    .command("list")
    .description("List organizations with their overview status")
    .option("--query <text>", "Filter by org name, slug, or domain")
    .option("--json", "Output as JSON")
    // Server-side manifest filters (preferred) — set any one to use /v1/admin/overviews
    .option("--stale-days <n>", "Include behind rows whose overview is at least N days old")
    .option("--missing", "Include orgs with no overview at all")
    .option("--has-activity", "Drop orgs with zero recent releases")
    // Legacy client-side flags
    .option("--stale", "(legacy) client-side staleness filter — prefer --stale-days / --missing")
    .option(
      "--stale-min-releases <n>",
      `(legacy) Min recent-release count to qualify as active (default ${STALE_MIN_RELEASES_DEFAULT})`,
    )
    .option(
      "--stale-grace-days <d>",
      `(legacy) Grace period in days before activity makes overview stale (default ${STALE_GRACE_DAYS_DEFAULT})`,
    )
    .addHelpText(
      "after",
      `
Examples:
  releases admin overview list
  releases admin overview list --stale-days 14 --missing --has-activity --json
  releases admin overview list --query vercel

The server-side manifest (--stale-days / --missing / --has-activity) is the
preferred path — one HTTP call returns the planning-ready rows. The legacy
--stale / --stale-min-releases / --stale-grace-days flags trigger a slower
client-side scan and remain for back-compat.`,
    )
    .action(overviewListAction);

  overview
    .command("plan")
    .description("Planning manifest with action and needsFetch hints (format=plan)")
    .option("--stale-days <n>", "Include behind rows whose overview is at least N days old")
    .option("--missing", "Include orgs with no overview at all")
    .option("--has-activity", "Drop orgs with zero recent releases")
    .option("--json", "Output as JSON (recommended for orchestrators)")
    .addHelpText(
      "after",
      `
Examples:
  releases admin overview plan --stale-days 14 --missing --has-activity --json
  releases admin overview plan --json

Adds per-row \`action\` (missing | refresh | skip | opted_out) and \`needsFetch\`
(true when the org has active sources but the most recent release is more than
7 days old — orchestrator should poll-and-fetch first). \`opted_out\` means the
org has auto-generate content off, so the batch skips it regardless of
staleness — flip it on with \`releases admin org update <org> --auto-generate-content\`.`,
    )
    .action(overviewPlanAction);

  overview
    .command("inputs")
    .description("Build the input payload for an overview regeneration")
    .argument("<org>", "Organization slug or ID")
    .option("--window <days>", "Lookback window in days (default 90)")
    .option("--limit <n>", "Max releases to include (default 50)")
    .option(
      "--check",
      "Pre-flight only — return {selected, totalAvailable, hasExistingContent, wouldRegenerate}",
    )
    .option(
      "--max-content-chars [n]",
      `With --json, clip each selected[].content to n chars before printing (bare: ${MAX_CONTENT_CHARS_DEFAULT})`,
    )
    .option("--json", "Output as JSON (recommended for agent consumption)")
    .addHelpText(
      "after",
      `
Examples:
  releases admin overview inputs vercel --json
  releases admin overview inputs vercel --check --json
  releases admin overview inputs vercel --window 30 --json
  releases admin overview inputs sentry --json --max-content-chars 1000

Use --check to decide whether to dispatch a regen sub-agent without paying for
the full release-content + media payload. Otherwise feed the JSON to the
generator described in the \`regenerating-overviews\` skill, then upload the
result with \`releases admin overview update\`.

--max-content-chars clips each selected release body to n characters (bare flag
defaults to ${MAX_CONTENT_CHARS_DEFAULT}) before the JSON is printed, leaving every other field intact
and never dropping a release. High-volume orgs (e.g. sentry, wordpress) emit
500K+ chars of full release content here; when an agent runs this via Bash that
exceeds the ~30K stdout cap and is silently truncated before the model sees it,
so the overview gets generated from only the first few releases. The clip
happens client-side — the CLI still receives the full payload over the wire —
so it removes that footgun without a multi-step jq workaround.`,
    )
    .action(overviewInputsAction);

  overview
    .command("update")
    .description("Upload a generated overview body for an organization")
    .argument("<org>", "Organization slug or ID")
    .requiredOption("--content-file <path>", "Path to a markdown file containing the overview")
    .option(
      "--citations-file <path>",
      "Path to a JSON array of inline source citations ({startIndex,endIndex,sourceUrl,title?,citedText})",
    )
    .option(
      "--release-count <n>",
      "Number of releases the overview reflects (defaults to totalAvailable from inputs)",
    )
    .option(
      "--last-contributing-at <iso>",
      "ISO timestamp of the most recent release reflected (defaults to first selected release)",
    )
    .option(
      "--unescape-html",
      "(default; no-op) HTML-entity decode now always runs before uploading",
    )
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin overview update vercel --content-file /tmp/vercel-overview.md
  releases admin overview update vercel --content-file - --json   (reads stdin)
  releases admin overview update vercel --content-file /tmp/o.md --citations-file /tmp/c.json

Writes via POST /v1/orgs/:slug/overview. Last-write-wins on conflict.
When --release-count or --last-contributing-at are omitted, the CLI re-fetches
overview-inputs to derive them.

Citations are replace-all on every write — omitting --citations-file CLEARS
any existing citations on the page. Pass an empty-array file to be explicit,
or include a non-empty array to swap them out.`,
    )
    .action(overviewUpdateAction);

  // ── Deprecated kebab-case aliases ──
  // Wired directly on the parent admin command to preserve the old surface
  // (`admin overview-list`, `admin overview-write`, `admin overview-inputs`).
  // Each warns then delegates to the canonical handler.

  admin
    .command("overview-list")
    .description("(deprecated — use overview list) List organizations with their overview status")
    .option("--stale", "Only show orgs whose overviews need regeneration")
    .option("--stale-min-releases <n>", "Min recent-release count to qualify as active")
    .option("--stale-grace-days <d>", "Grace period in days before activity makes overview stale")
    .option("--query <text>", "Filter by org name, slug, or domain")
    .option("--stale-days <n>", "Include behind rows whose overview is at least N days old")
    .option("--missing", "Include orgs with no overview at all")
    .option("--has-activity", "Drop orgs with zero recent releases")
    .option("--json", "Output as JSON")
    .action(
      warnDeprecatedAlias<[OverviewListOpts]>("overview-list", "overview list", overviewListAction),
    );

  admin
    .command("overview-inputs")
    .description("(deprecated — use overview inputs) Build the input payload for a regeneration")
    .argument("<org>", "Organization slug or ID")
    .option("--window <days>", "Lookback window in days (default 90)")
    .option("--limit <n>", "Max releases to include (default 50)")
    .option("--check", "Pre-flight only")
    .option("--json", "Output as JSON")
    .action(
      warnDeprecatedAlias<[string, OverviewInputsOpts]>(
        "overview-inputs",
        "overview inputs",
        overviewInputsAction,
      ),
    );

  admin
    .command("overview-write")
    .description("(deprecated — use overview update) Upload a generated overview body")
    .argument("<org>", "Organization slug or ID")
    .requiredOption("--content-file <path>", "Path to a markdown file containing the overview")
    .option("--citations-file <path>", "Path to a JSON array of inline source citations")
    .option("--release-count <n>", "Number of releases the overview reflects")
    .option("--last-contributing-at <iso>", "ISO timestamp of the most recent release reflected")
    .option("--unescape-html", "(default; no-op) HTML-entity decode now always runs")
    .option("--json", "Output as JSON")
    .action(
      warnDeprecatedAlias<[string, OverviewUpdateOpts]>(
        "overview-write",
        "overview update",
        overviewUpdateAction,
      ),
    );
}
