import { Command } from "commander";
import chalk from "chalk";
import { findOrg, createOrg } from "../../api/orgs.js";
import { findProduct } from "../../api/products.js";
import { createSource, findSourcesByUrls, isUrlExcluded } from "../../api/sources.js";
import { toSlug } from "@buildinternet/releases-core/slug";
import { SOURCE_TYPES, type SourceType } from "@buildinternet/releases-core/source-enums";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";
import { markDryRun } from "../../lib/dry-run.js";
import { readContentArg, readJsonInputArg } from "../../lib/input.js";
import { CliError } from "../../lib/errors.js";
import { parseMetadataSetFlag, parseTagList } from "../../lib/flags.js";
import { isAppStoreUrl, isAppStoreCoordinate } from "./create-appstore.js";
import { isVideoUrl } from "./create-video.js";

function isValidType(t: string): t is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(t);
}

const APPSTORE_REDIRECT =
  "App Store sources use a dedicated command: `releases admin source create-appstore <url-or-id>` " +
  "(it resolves the listing, mints the first release, and backfills the app icon). " +
  "`source create` cannot materialize them.";

const VIDEO_REDIRECT =
  "Video sources use a dedicated command: `releases admin source create-video <channel-or-playlist-url> --org <slug>` " +
  "(it resolves the channel/playlist feed, mints a `video` source, and backfills video descriptions through the " +
  "marketing-filtered ingest). `source create` cannot materialize them — a generic feed/scrape source over a " +
  "YouTube URL silently produces empty release bodies.";

export function isGitHubUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/.test(url);
}

interface CreateSourceInput {
  name: string;
  url: string;
  type?: string;
  slug?: string;
  org?: string;
  product?: string;
  feedUrl?: string;
  /** Comma-separated feed keyword allowlist → `metadata.feedKeywordAllow`. */
  keywordAllow?: string;
  /** Raw `key=value` tokens → arbitrary `metadata` keys (mirrors `source update`). */
  metadataSet?: string[];
  /** Mark the source as the org's primary changelog (→ `isPrimary: true` on create). */
  primary?: boolean;
  batch?: boolean;
  strict?: boolean;
  dryRun?: boolean;
}

interface CreateSourceResult {
  name: string;
  slug: string;
  type: string;
  url: string;
  org?: string;
  status: "added" | "error" | "ignored" | "would-add";
  existed?: boolean;
  error?: string;
  reason?: string;
}

async function createSingleSource(input: CreateSourceInput): Promise<CreateSourceResult> {
  const { name, url } = input;

  // Video sources (YouTube channels/playlists) can't be materialized through
  // the generic create path — the dedicated endpoint resolves the channel/
  // playlist to its Atom feed, mints a `video` source, and backfills video
  // descriptions through the marketing-filtered ingest. A generic feed/scrape
  // source over a YouTube URL silently produces empty release bodies (the feed
  // parser drops `media:group/media:description`) — issue #1260. Reject an
  // explicit `--type video` or a pasted youtube.com/youtu.be URL, pointing the
  // caller at `create-video`. Runs BEFORE the isValidType check because `video`
  // is a dedicated endpoint-only type, not a generic-`create` source type (and
  // may not be present in this CLI's pinned source-type enum).
  if (input.type === "video" || isVideoUrl(url)) {
    return {
      name,
      slug: input.slug ?? toSlug(name),
      type: "video",
      url,
      status: "error",
      error: VIDEO_REDIRECT,
    };
  }

  if (input.type && !isValidType(input.type)) {
    return {
      name,
      slug: input.slug ?? toSlug(name),
      type: input.type,
      url,
      status: "error",
      error: `Invalid type "${input.type}". Must be one of: ${SOURCE_TYPES.join(", ")}`,
    };
  }

  const slug = input.slug ?? toSlug(name);

  // Resolve source type early so the dedup pre-check can run before any
  // org/product side effects. Type detection is pure (only depends on input).
  let sourceType: SourceType;
  const metadata: Record<string, unknown> = {};

  if (input.feedUrl) {
    sourceType = (input.type as SourceType) ?? "feed";
    metadata.feedUrl = input.feedUrl;
    metadata.feedType = "unknown";
    metadata.feedDiscoveredAt = new Date().toISOString();
    metadata.noFeedFound = false;
    logger.info(`Using provided feed URL — ${sourceType} adapter`);
  } else if (input.type) {
    sourceType = input.type as SourceType;
  } else {
    sourceType = isGitHubUrl(url) ? "github" : "scrape";
    if (sourceType === "github") {
      logger.info("Detected GitHub URL — using github adapter");
    }
  }

  // Atomic metadata at create time. Setting feed filters here — rather than via
  // a follow-up `source update --metadata-set` — closes the race with the
  // onboard workflow's auto-fetch, which reads the source's metadata before any
  // post-create edit lands and would otherwise ingest the whole *unfiltered*
  // feed on the first pass (#237).
  const keywordAllow = parseTagList(input.keywordAllow);
  if (keywordAllow.length > 0) metadata.feedKeywordAllow = keywordAllow;
  for (const token of input.metadataSet ?? []) {
    const [key, value] = parseMetadataSetFlag(token);
    metadata[key] = value;
  }

  // App Store sources can't be materialized through the generic create path —
  // they need the dedicated endpoint that resolves the iTunes listing, mints
  // the first release, and backfills the app icon. Reject an explicit
  // `--type appstore`, a pasted `apps.apple.com` URL (which would otherwise be
  // mis-detected as `scrape`), or an `appstore:<id>` coordinate, pointing the
  // caller at `create-appstore`.
  if (sourceType === "appstore" || isAppStoreUrl(url) || isAppStoreCoordinate(url)) {
    return {
      name,
      slug,
      type: "appstore",
      url,
      status: "error",
      error: APPSTORE_REDIRECT,
    };
  }

  // Pre-check for duplicate URL BEFORE any side-effecting calls (createOrg,
  // findProduct). The API does not reject duplicate source URLs — it
  // auto-suffixes the slug and creates a new row. Running this first also
  // prevents a wasted createOrg() if the caller's --org doesn't exist yet but
  // the source already does.
  const existingByUrl = await findSourcesByUrls([url]);
  if (existingByUrl.length > 0) {
    if (input.strict) {
      return {
        name,
        slug,
        type: sourceType,
        url,
        status: "error",
        error: `Source URL already exists: ${url}`,
      };
    }
    const src = existingByUrl[0];
    // Report the org actually attached to the existing record, not the one the
    // caller passed in — passing --org=wrong-org should not relabel a source
    // that already belongs to right-org in the response payload.
    const existingOrg = src.orgId ? await findOrg(src.orgId) : null;
    // #794 item 3: when the operator requested a specific --org / --product
    // and the existing row is attached to a *different* one, exit non-zero
    // with the current attribution and the update hint. Pre-fix this was a
    // silent no-op that made multi-product onboarding need manual cleanup.
    const requestedOrg = input.org ? await findOrg(input.org) : null;
    const requestedProduct = input.product ? await findProduct(input.product) : null;
    const orgMismatch = Boolean(requestedOrg && existingOrg && requestedOrg.id !== existingOrg.id);
    const productMismatch = Boolean(
      requestedProduct && requestedProduct.id !== (src.productId ?? null),
    );
    if (orgMismatch || productMismatch) {
      const reqLabel = [`org=${input.org ?? "∅"}`, `product=${input.product ?? "∅"}`].join(", ");
      const curLabel = [
        `org=${existingOrg?.slug ?? "∅"}`,
        `productId=${src.productId ?? "∅"}`,
      ].join(", ");
      return {
        name: src.name,
        slug: src.slug,
        type: src.type,
        url: src.url,
        org: existingOrg?.name ?? undefined,
        status: "error",
        existed: true,
        error: `Source URL already exists with different attribution. requested {${reqLabel}}; current {${curLabel}}. Run \`releases admin source update ${src.slug} --org <slug> --product <slug>\` to re-attach.`,
      };
    }
    logger.info(`Source already exists: ${src.name} (${src.slug}) — returning existing`);
    return {
      name: src.name,
      slug: src.slug,
      type: src.type,
      url: src.url,
      org: existingOrg?.name ?? undefined,
      status: "added",
      existed: true,
    };
  }

  let orgId: string | null = null;
  let orgName: string | null = null;

  if (input.org) {
    let org = await findOrg(input.org);
    if (!org) {
      // Don't auto-create when the operator passed a typed ID — an unresolved
      // `org_…` is a typo, not a request to spin up a new org.
      if (input.org.startsWith("org_") || input.org.includes("/")) {
        throw new Error(`Organization not found: ${input.org}`);
      }
      if (input.dryRun) {
        // Skip the createOrg side-effect; just report what we'd do.
        const projectedSlug = toSlug(input.org);
        logger.info(`[dry-run] Would create organization: ${input.org} (${projectedSlug})`);
        orgName = input.org;
      } else {
        org = await createOrg(input.org, { slug: toSlug(input.org) });
        logger.info(`Created organization: ${org.name} (${org.slug})`);
        orgId = org.id;
        orgName = org.name;
      }
    } else {
      orgId = org.id;
      orgName = org.name;
    }
  }

  let productId: string | null = null;
  if (input.product) {
    const prod = await findProduct(input.product);
    if (!prod) {
      return {
        name,
        slug,
        type: sourceType,
        url,
        status: "error",
        error: `Product not found: "${input.product}"`,
      };
    }
    productId = prod.id;
    if (!orgId) orgId = prod.orgId;
  }

  if (!input.org && sourceType === "github") {
    const match = url.match(/github\.com\/([^/]+)\//);
    if (match) {
      const org = await findOrg(match[1]);
      if (org) {
        orgId = org.id;
        orgName = org.name;
        logger.info(`Auto-linked to organization "${orgName}"`);
      }
    }
  }

  const exclusion = await isUrlExcluded(url, orgId ?? undefined);
  if (exclusion.excluded) {
    const scopeLabel = exclusion.scope === "blocked" ? "blocked" : "ignored";
    logger.warn(
      `Skipping ${scopeLabel} URL: ${url}${exclusion.reason ? ` (${exclusion.reason})` : ""}`,
    );
    return {
      name,
      slug,
      type: sourceType,
      url,
      org: orgName ?? undefined,
      status: "ignored",
      reason: exclusion.reason,
    };
  }

  if (input.dryRun) {
    return {
      name,
      slug,
      type: sourceType,
      url,
      org: orgName ?? undefined,
      status: "would-add",
      existed: false,
    };
  }

  try {
    await createSource({
      name,
      slug,
      type: sourceType,
      url,
      orgId,
      productId,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
      // Omit unless explicitly set so the create body stays minimal and the API
      // applies its own default (matches the `metadata` omit-when-empty pattern).
      isPrimary: input.primary ? true : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      slug,
      type: sourceType,
      url,
      org: orgName ?? undefined,
      status: "error",
      error: message,
    };
  }

  return {
    name,
    slug,
    type: sourceType,
    url,
    org: orgName ?? undefined,
    status: "added",
    existed: false,
  };
}

export type CreateSourceOpts = {
  type?: string;
  url?: string;
  slug?: string;
  org?: string;
  product?: string;
  name?: string;
  feedUrl?: string;
  keywordAllow?: string;
  metadataSet?: string[];
  primary?: boolean;
  batch?: string;
  /** Raw single-source JSON body (literal, `@file`, or `-` for stdin) → CreateSourceInput. */
  input?: string;
  json?: boolean;
  strict?: boolean;
  dryRun?: boolean;
};

/**
 * Render the outcome of a single `createSingleSource` call. Shared by the
 * flag-driven path and the `--input` raw-payload path so both emit the same
 * structured `--json` / human output. Exits non-zero on `status: "error"`.
 */
async function renderSingleCreateResult(
  result: CreateSourceResult,
  opts: Pick<CreateSourceOpts, "json" | "dryRun">,
  typeWasExplicit: boolean,
): Promise<void> {
  if (result.status === "error") {
    if (opts.json) await writeJson(result);
    else logger.error(chalk.red(result.error!));
    process.exit(1);
  }

  if (result.status === "ignored") {
    if (opts.json) await writeJson(result);
    return;
  }

  if (opts.json) {
    await writeJson(opts.dryRun ? markDryRun(result) : result);
    return;
  }

  const orgLabel = result.org ? ` [org: ${result.org}]` : "";
  const typeLabel = typeWasExplicit ? "" : ` (auto-detected: ${result.type})`;
  if (result.status === "would-add") {
    logger.info(
      chalk.yellow(
        `[dry-run] Would create source: ${result.name} (${result.slug})${typeLabel}${orgLabel}`,
      ),
    );
  } else if (result.existed) {
    logger.info(
      chalk.yellow(
        `Source already exists: ${result.name} (${result.slug})${typeLabel}${orgLabel} — returning existing`,
      ),
    );
  } else {
    logger.info(
      chalk.green(`Source created: ${result.name} (${result.slug})${typeLabel}${orgLabel}`),
    );
  }
}

/** Shared action for both the canonical `create` command and the deprecated `add` alias. */
export async function createSourceAction(
  name: string | undefined,
  opts: CreateSourceOpts,
): Promise<void> {
  if (opts.batch && opts.input !== undefined) {
    throw new CliError(
      "--batch and --input are mutually exclusive (--input takes a single source).",
    );
  }

  if (opts.input !== undefined) {
    const body = await readJsonInputArg(opts.input);
    if (Array.isArray(body)) {
      throw new CliError(
        "--input takes a single source object; use --batch for an array of sources.",
      );
    }
    if (body === null || typeof body !== "object") {
      throw new CliError(
        "--input must be a JSON object describing one source (at least name and url).",
      );
    }
    const entry = body as Partial<CreateSourceInput>;
    // Validate the type, not just truthiness: the field is *typed* string, but a
    // JSON body can carry anything (`{"name": 123}` is valid JSON), and a
    // non-string would otherwise reach createSingleSource and misbehave in
    // toSlug()/downstream string ops instead of failing with a clean message.
    if (
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      typeof entry.url !== "string" ||
      entry.url.length === 0
    ) {
      throw new CliError('--input requires non-empty string "name" and "url" fields.');
    }
    // Body provides the content; --strict/--dry-run stay execution modifiers
    // from the CLI flags (override anything the body tried to set).
    const result = await createSingleSource({
      ...entry,
      name: entry.name,
      url: entry.url,
      strict: opts.strict,
      dryRun: opts.dryRun,
    });
    await renderSingleCreateResult(result, opts, entry.type !== undefined);
    return;
  }

  if (opts.batch) {
    const raw = await readContentArg(opts.batch);

    let entries: CreateSourceInput[];
    try {
      entries = JSON.parse(raw);
    } catch {
      logger.error("Failed to parse batch JSON input");
      process.exit(1);
    }

    if (!Array.isArray(entries)) {
      logger.error("Batch input must be a JSON array");
      process.exit(1);
    }

    for (const [i, entry] of entries.entries()) {
      if (!entry.name || !entry.url) {
        logger.error(`Entry ${i} is missing required "name" or "url" field`);
        process.exit(1);
      }
    }

    const results: CreateSourceResult[] = [];
    let hasError = false;

    // Sequential to avoid racing on shared org lookup-or-create for entries
    // referencing the same org.
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      const result = await createSingleSource({
        ...entry,
        batch: true,
        strict: opts.strict,
        dryRun: opts.dryRun,
      });
      results.push(result);

      if (result.status === "error") {
        hasError = true;
        if (!opts.json) logger.error(chalk.red(`Failed to create ${result.name}: ${result.error}`));
      } else if (result.status === "ignored") {
        if (!opts.json)
          logger.info(
            chalk.yellow(
              `Skipped (ignored): ${result.name} (${result.url})${result.reason ? ` — ${result.reason}` : ""}`,
            ),
          );
      } else if (!opts.json) {
        const orgLabel = result.org ? ` [org: ${result.org}]` : "";
        if (result.status === "would-add") {
          logger.info(
            chalk.yellow(
              `[dry-run] Would create source: ${result.name} (${result.slug}) [${result.type}]${orgLabel}`,
            ),
          );
        } else if (result.existed) {
          logger.info(
            chalk.yellow(
              `Source already exists: ${result.name} (${result.slug}) [${result.type}]${orgLabel} — returning existing`,
            ),
          );
        } else {
          logger.info(
            chalk.green(
              `Source created: ${result.name} (${result.slug}) [${result.type}]${orgLabel}`,
            ),
          );
        }
      }
    }

    if (opts.json) await writeJson(opts.dryRun ? results.map(markDryRun) : results);
    if (hasError) process.exit(1);
    return;
  }

  const effectiveName = name ?? opts.name;
  if (!effectiveName) {
    logger.error(
      'missing required argument: name\n\n  releases admin source create "My Source" --url https://example.com/changelog',
    );
    process.exit(1);
  }
  if (!opts.url) {
    logger.error("missing required option: --url");
    process.exit(1);
  }

  const result = await createSingleSource({
    name: effectiveName,
    url: opts.url,
    type: opts.type,
    slug: opts.slug,
    org: opts.org,
    product: opts.product,
    feedUrl: opts.feedUrl,
    keywordAllow: opts.keywordAllow,
    metadataSet: opts.metadataSet,
    primary: opts.primary,
    strict: opts.strict,
    dryRun: opts.dryRun,
  });

  await renderSingleCreateResult(result, opts, opts.type !== undefined);
}

function attachCreateOptions(cmd: Command): Command {
  return cmd
    .argument("[name]", "Display name for the source")
    .option(
      "--type <type>",
      "Source type: github, scrape, feed, or agent (auto-detected from URL if omitted). App Store apps use `source create-appstore`; YouTube channels/playlists use `source create-video`.",
    )
    .option("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .option("--org <org>", "Organization name or slug (creates if not found)")
    .option("--product <product>", "Product slug to assign this source to")
    .option("--name <name>", "Display name for the source (alternative to positional argument)")
    .option("--feed-url <feedUrl>", "Explicit feed URL")
    .option(
      "--keyword-allow <list>",
      "Comma-separated feed keyword allowlist (→ metadata.feedKeywordAllow). Items whose " +
        "title/link don't match a keyword are dropped at ingest. Set at create time so the " +
        "onboard auto-fetch is filtered from the first pass — see --metadata-set for arbitrary keys.",
    )
    .option(
      "--metadata-set <key=value>",
      "Set a source metadata key at create time (repeatable). Same coercion as " +
        "`source update --metadata-set`: true/false/null → JSON literal; number string → number; " +
        "value starting with { or [ → parsed as JSON; otherwise → string. Keys with `.`/`[` are rejected.",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option(
      "--primary",
      "Mark as the org's primary changelog source (sets isPrimary on create — no follow-up `source update --primary` needed)",
    )
    .option("--batch <file>", "JSON file with sources to add (use - for stdin)")
    .option(
      "--input <json>",
      "Raw JSON body for ONE source (mirrors the --batch element shape: name, url, " +
        "type, slug, org, product, feedUrl, keywordAllow, metadataSet, primary). Pass a literal " +
        "JSON string, @<path> for a file, or - for stdin. Lets an agent send the payload directly " +
        "instead of reverse-mapping it onto flags. Mutually exclusive with --batch; --strict/--dry-run still apply.",
    )
    .option("--json", "Output as JSON")
    .option("--strict", "Exit 1 if the source URL already exists (default: return existing)")
    .option("--dry-run", "Show what would be created without writing");
}

export function registerCreateCommand(program: Command) {
  attachCreateOptions(
    program
      .command("create")
      .description("Add a new changelog source")
      .addHelpText(
        "after",
        `
Examples:
  releases admin source create "Next.js" --url https://github.com/vercel/next.js
  releases admin source create "Vitest" --url https://github.com/vitest-dev/vitest --org vitest --primary
  releases admin source create "Astro" --url https://astro.build/blog --type scrape
  releases admin source create "Discord" --url https://discord.com/blog --type feed \\
    --feed-url https://discord.com/blog/rss.xml --keyword-allow changelog,patch-notes
  releases admin source create "Acme" --url https://acme.dev/changelog \\
    --metadata-set marketingFilter=true --metadata-set feedContentDepth=summary-only
  releases admin source create --batch sources.json
  releases admin source create --input '{"name":"Astro","url":"https://astro.build/blog","type":"scrape"}'
  releases admin source create --input @source.json
  echo '{"name":"Astro","url":"https://astro.build/blog"}' | releases admin source create --input -`,
      ),
  ).action(createSourceAction);
}
