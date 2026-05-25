/**
 * Experimental: `POST /v1/changelog/fetch` — given a GitHub `owner/repo`
 * coordinate, discover every CHANGELOG file in the repo and return the full
 * inventory (path + size, enumerated for free by a single recursive Git Trees
 * call) plus efficiency stats. Bodies are downloaded for a short excerpt only
 * for the first `EXCERPT_LIMIT` files; the rest are inventory-only. **Nothing
 * is persisted** — no D1/KV/R2 writes, no source row required.
 *
 * Coordinate-based sibling of the source-scoped changelog probe
 * (`POST /v1/sources/:slug/changelog/probe`): it reuses the shared repo
 * precheck (`classifyRepoStatus`) and the worker-safe tree-search discovery
 * (`discoverChangelogPathsViaTree`, which falls back to the workspace walk on
 * truncation/failure), then does its own lightweight body-fetch loop since the
 * cron fetch path's body fetcher is Node-flavored. Hidden from the production
 * OpenAPI spec; auth-gated as a write (Bearer) like the probe.
 */
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { hideInProduction } from "../openapi.js";
import {
  discoverChangelogPathsViaTree,
  buildGitHubHeaders,
  createListingCache,
} from "@releases/adapters/github-discovery";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import type { Source } from "@buildinternet/releases-core/schema";
import { selectChangelogFile } from "@buildinternet/releases-core/changelog-slice";
import {
  parseChangelog,
  mapGitHubReleases,
  type ParsedChangelogRelease,
  type GitHubReleaseLike,
} from "@buildinternet/releases-core/changelog-parse";
import { ErrorResponseSchema } from "@buildinternet/releases-api-types";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { classifyRepoStatus } from "../lib/github-repo-status.js";
import type { Env } from "../index.js";

/** How many file bodies we download for excerpts. The inventory (paths +
 *  sizes) is complete and free from the single tree call; only excerpt fetches
 *  are bounded — each is a sequential round-trip against the rate-limited raw API. */
const EXCERPT_LIMIT = 20;
/** A file larger than this would be tail-truncated by the real ingest path; we
 *  download it whole (cost is real) and just flag it. Matches CHANGELOG_MAX_BYTES. */
const MAX_BYTES = 1024 * 1024;
/** How much of each fetched file body to echo back. Newest entries sit at the
 *  top of a conventional changelog, so the head is the useful slice. */
const EXCERPT_CHARS = 2000;

const encoder = new TextEncoder();

const ChangelogFileSchema = z.object({
  path: z.string(),
  filename: z.string(),
  origin: z.enum(["root", "workspace", "override"]),
  url: z.string(),
  rawUrl: z.string(),
  /** Blob size in bytes from the recursive tree; null on the walk fallback. */
  size: z.number().nullable(),
  /** True when the body was downloaded for an excerpt (first EXCERPT_LIMIT files). */
  fetched: z.boolean(),
  /** First ~2000 chars of the body; null for inventory-only (un-fetched) entries. */
  excerpt: z.string().nullable(),
  /** Body exceeded the 1MB cap (only meaningful when fetched). */
  truncated: z.boolean(),
});

const ChangelogFetchStatsSchema = z.object({
  /** Total changelog files discovered (the full inventory). */
  pathsDiscovered: z.number(),
  /** How many bodies were downloaded for excerpts (≤ EXCERPT_LIMIT). */
  filesFetched: z.number(),
  /** Bytes actually downloaded (sum of fetched bodies). */
  totalBytes: z.number(),
  /** Sum of sizes across all discovered files, from the tree (excludes nulls). */
  inventoryBytes: z.number(),
  truncatedCount: z.number(),
  githubRequests: z.number(),
  elapsedMs: z.number(),
});

const ChangelogFetchResponseSchema = z.object({
  repo: z.string(),
  files: z.array(ChangelogFileSchema),
  stats: ChangelogFetchStatsSchema,
});

const fetchChangelogsRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Changelog"],
  summary: "Fetch CHANGELOG files for a GitHub repo (experimental, no persistence)",
  description:
    'Experimental. Given a `{ repo: "owner/repo" }` coordinate (or `github:owner/repo`), discovers every CHANGELOG file via a single recursive Git Trees call (falling back to a per-directory workspace walk on truncation/failure) and returns the full inventory — path, origin, and size per file. Bodies are downloaded for a ~2KB excerpt only for the first 20 files; the rest are inventory-only (`fetched: false`, `excerpt: null`). Includes efficiency stats (`githubRequests`, `totalBytes`, `inventoryBytes`, `elapsedMs`). Nothing is written to D1/KV/R2 and no source row is required. Auth: Bearer (write) via `publicReadAuthMiddleware`\'s non-SAFE_METHODS branch. Hidden from the production OpenAPI spec.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Discovered changelog files with excerpts and efficiency stats",
      content: { "application/json": { schema: resolver(ChangelogFetchResponseSchema) } },
    },
    400: {
      description: "Missing/invalid `repo`, or not a parseable github owner/repo coordinate",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Repo not found on GitHub",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    502: {
      description: "GitHub auth error or upstream 5xx",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    503: {
      description: "GitHub rate limit exceeded",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

const fetchChangelogsHandler = async (c: import("hono").Context<Env>) => {
  const startedAt = Date.now();

  const body = (await c.req.json().catch(() => null)) as { repo?: unknown } | null;
  const repoInput = typeof body?.repo === "string" ? body.repo.trim() : "";
  if (!repoInput) {
    return c.json(
      {
        error: "bad_request",
        message: 'Body must include a "repo" string, e.g. { "repo": "owner/repo" }',
      },
      400,
    );
  }

  const coord = parseCoordinate(repoInput);
  if (!coord) {
    return c.json(
      {
        error: "bad_request",
        message: `Cannot parse "${repoInput}" as a github owner/repo coordinate`,
      },
      400,
    );
  }
  const { org: owner, repo } = coord;

  const token = (await getSecret(c.env.GITHUB_TOKEN)) ?? undefined;
  const headers = buildGitHubHeaders(token, RELEASES_BOT_UA);

  // Precheck so a transient GitHub failure surfaces as 404/502/503 instead of
  // an empty file list (the planner swallows upstream errors).
  const repoStatus = await classifyRepoStatus({ owner, repo }, headers.apiHeaders);
  if (repoStatus.kind !== "ok") {
    return c.json(repoStatus.body, repoStatus.status);
  }

  // Discovery only reads `url` (for owner/repo) and `metadata` (for
  // changelogPaths overrides, which a coordinate caller never has), so a
  // minimal synthetic Source is enough — no DB row required.
  const syntheticSource = {
    url: `https://github.com/${owner}/${repo}`,
    metadata: null,
  } as unknown as Source;

  // Tree-search discovery: one recursive Git Trees call enumerates the whole
  // inventory (paths + sizes) for free, falling back to the workspace walk on
  // truncation/failure. Caller-owned cache reports the upstream request count.
  const cache = createListingCache();
  const discovered = (
    (await discoverChangelogPathsViaTree(syntheticSource, headers, cache)) ?? []
  ).filter((p) => p.exists);

  const files: z.infer<typeof ChangelogFileSchema>[] = [];
  let bodyFetches = 0;
  let totalBytes = 0;
  let inventoryBytes = 0;
  let truncatedCount = 0;

  for (const entry of discovered) {
    const lastSlash = entry.path.lastIndexOf("/");
    const filename = lastSlash === -1 ? entry.path : entry.path.slice(lastSlash + 1);
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${entry.path}`;
    if (entry.size != null) inventoryBytes += entry.size;

    // The inventory is complete and free; only download bodies (for excerpts)
    // up to the cap. Files past it are returned inventory-only.
    let excerpt: string | null = null;
    let truncated = false;
    if (bodyFetches < EXCERPT_LIMIT) {
      bodyFetches++;
      try {
        // oxlint-disable-next-line no-await-in-loop -- raw API is rate-limited; fetch sequentially like the cron path
        const res = await fetch(rawUrl, { headers: headers.rawHeaders });
        if (res.ok) {
          // oxlint-disable-next-line no-await-in-loop -- body read paired with the sequential fetch above
          const text = await res.text();
          const bytes = encoder.encode(text).length;
          truncated = bytes > MAX_BYTES;
          totalBytes += bytes;
          if (truncated) truncatedCount++;
          excerpt = text.slice(0, EXCERPT_CHARS);
        }
      } catch {
        // leave excerpt null on fetch failure
      }
    }

    files.push({
      path: entry.path,
      filename,
      origin: entry.origin,
      url: `https://github.com/${owner}/${repo}/blob/HEAD/${entry.path}`,
      rawUrl,
      size: entry.size,
      fetched: excerpt !== null,
      excerpt,
      truncated,
    });
  }

  const stats = {
    pathsDiscovered: discovered.length,
    filesFetched: files.filter((f) => f.fetched).length,
    totalBytes,
    inventoryBytes,
    truncatedCount,
    // 1 repo precheck + discovery (tree call, or walk listings on fallback) + one raw fetch per excerpted file.
    githubRequests: 1 + cache.requests + bodyFetches,
    elapsedMs: Date.now() - startedAt,
  };

  logEvent("info", {
    component: "changelog-fetch-experiment",
    event: "fetched",
    repo: `${owner}/${repo}`,
    ...stats,
  });

  return c.json({ repo: `${owner}/${repo}`, files, stats });
};

// ---------------------------------------------------------------------------
// POST /changelog/parse
// ---------------------------------------------------------------------------

const PARSE_SOURCES = ["auto", "github_releases", "changelog_file"] as const;

const ParsedReleaseSchema = z.object({
  version: z.string().nullable(),
  type: z.literal("feature"),
  title: z.string(),
  content: z.string(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  summary: z.null(),
  titleGenerated: z.null(),
  titleShort: z.null(),
  // always empty at runtime; z.unknown() keeps OpenAPI spec generation safe.
  media: z.array(z.unknown()),
});

const ChangelogParseFileSchema = z.object({
  path: z.string(),
  url: z.string(),
  rawUrl: z.string(),
  size: z.number().nullable(),
  truncated: z.boolean(),
});

const ChangelogParseResponseSchema = z.object({
  repo: z.string(),
  source: z.enum(["github_releases", "changelog_file"]).nullable(),
  parsable: z.boolean(),
  /**
   * True when the resolved source is GitHub Releases and we fetched a full page
   * (per_page=100) without paginating — i.e. older releases very likely exist.
   * Always false for the CHANGELOG.md source (the whole file is parsed; size
   * truncation is reported on `file.truncated` instead).
   */
  capped: z.boolean(),
  format: z.enum(["keep-a-changelog", "conventional", "plain", "unknown"]).nullable(),
  file: ChangelogParseFileSchema.nullable(),
  releases: z.array(ParsedReleaseSchema),
  stats: z.object({
    releasesParsed: z.number(),
    headingsScanned: z.number(),
    skipped: z.number(),
    githubRequests: z.number(),
    bytes: z.number(),
    elapsedMs: z.number(),
  }),
});

const parseChangelogRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Changelog"],
  summary:
    "Parse a GitHub repo's changelog into structured releases (experimental, no persistence)",
  description:
    'Experimental. Given a `{ repo: "owner/repo", path?, source? }` coordinate, resolves the repo\'s changelog deterministically from the best available source — GitHub Releases (already structured) or a parsed root `CHANGELOG.md` — and returns release entries in the stored-release shape. `source` is `"auto"` (default), `"github_releases"`, or `"changelog_file"`; `path` forces the file source at that path. Nothing is written. Auth: Bearer (write). Hidden from the production OpenAPI spec.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Structured releases plus the resolved source and stats",
      content: { "application/json": { schema: resolver(ChangelogParseResponseSchema) } },
    },
    400: {
      description: "Missing/invalid `repo`, unparseable coordinate, or invalid `source`",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Repo not found, or an explicit `path` that does not exist",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    502: {
      description: "GitHub auth error or upstream 5xx",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    503: {
      description: "GitHub rate limit exceeded",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

type ChangelogParseSource = (typeof PARSE_SOURCES)[number];

/** Single-page release cap — we request one page of this size and don't paginate. */
const RELEASES_PER_PAGE = 100;

/**
 * Fetch + map a repo's GitHub Releases (one page). `failed` is set on a
 * transport error or non-OK / unparseable response — distinct from a 200 with
 * an empty array, which is just a repo with no releases. Repo-level auth /
 * rate-limit / 5xx are already surfaced upfront by `classifyRepoStatus`; this
 * lets a forced `github_releases` request report the rare post-precheck failure
 * instead of masking it as "no releases". `capped` is true when a full page
 * came back, signalling there are very likely older releases we didn't fetch.
 */
async function fetchGitHubReleases(
  owner: string,
  repo: string,
  apiHeaders: Record<string, string>,
): Promise<{ releases: ParsedChangelogRelease[]; failed: boolean; capped: boolean }> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_PAGE}`,
      { headers: apiHeaders },
    );
  } catch {
    return { releases: [], failed: true, capped: false };
  }
  if (!res.ok) return { releases: [], failed: true, capped: false };
  const data = (await res.json().catch(() => null)) as GitHubReleaseLike[] | null;
  if (!Array.isArray(data)) return { releases: [], failed: true, capped: false };

  // GitHub's default list order is by the tag commit's `created_at`, which
  // diverges from publish order on repos with interleaved release lines (e.g.
  // Node's parallel LTS branches), making the viewer's version rail look
  // unsorted. Re-sort by `published_at` descending — authoritative for this
  // source — so it's reliably newest-first; undated entries sink to the end.
  // `Array.sort` is stable, so equal/undated entries keep their API order.
  const releases = mapGitHubReleases(data).sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
    return tb - ta;
  });

  // A full page means there are very likely older releases we didn't fetch
  // (no pagination). The viewer renders this as "100+".
  return { releases, failed: false, capped: data.length >= RELEASES_PER_PAGE };
}

interface ResolvedFile {
  file: z.infer<typeof ChangelogParseFileSchema>;
  result: ReturnType<typeof parseChangelog>;
  bytes: number;
}

/**
 * Outcome of resolving the CHANGELOG file source:
 * - `ok`        — a file was found and its body fetched + parsed.
 * - `not_found` — no changelog file matched (root absent, or `path` missing).
 * - `error`     — the raw body fetch failed (transport / non-OK). A forced
 *                 request surfaces this as 502; `auto` degrades past it.
 */
type ResolveOutcome =
  | ({ kind: "ok" } & ResolvedFile)
  | { kind: "not_found" }
  | { kind: "error"; status: number };

/**
 * Discover + select one CHANGELOG file (root by default, or `path`), fetch its
 * full body (≤ MAX_BYTES), and parse it.
 */
async function resolveChangelogFile(
  owner: string,
  repo: string,
  headers: ReturnType<typeof buildGitHubHeaders>,
  cache: ReturnType<typeof createListingCache>,
  path: string | null,
): Promise<ResolveOutcome> {
  const syntheticSource = {
    url: `https://github.com/${owner}/${repo}`,
    metadata: null,
  } as unknown as Source;

  const discovered = (
    (await discoverChangelogPathsViaTree(syntheticSource, headers, cache)) ?? []
  ).filter((p) => p.exists);
  const selected = selectChangelogFile(discovered, path);
  if (!selected) return { kind: "not_found" };

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${selected.path}`;
  let res: Response;
  try {
    res = await fetch(rawUrl, { headers: headers.rawHeaders });
  } catch {
    return { kind: "error", status: 502 };
  }
  if (!res.ok) return { kind: "error", status: res.status };

  const bodyText = await res.text();
  const bytes = encoder.encode(bodyText).length;

  return {
    kind: "ok",
    file: {
      path: selected.path,
      url: `https://github.com/${owner}/${repo}/blob/HEAD/${selected.path}`,
      rawUrl,
      size: selected.size,
      truncated: bytes > MAX_BYTES,
    },
    result: parseChangelog(bodyText),
    bytes,
  };
}

/** Map a failed GitHub sub-call to an upstream HTTP status (rate-limit → 503, else 502). */
const upstreamStatus = (status: number): 502 | 503 => (status === 429 ? 503 : 502);

const parseChangelogHandler = async (c: import("hono").Context<Env>) => {
  const startedAt = Date.now();

  const body = (await c.req.json().catch(() => null)) as {
    repo?: unknown;
    path?: unknown;
    source?: unknown;
  } | null;

  const repoInput = typeof body?.repo === "string" ? body.repo.trim() : "";
  if (!repoInput) {
    return c.json(
      {
        error: "bad_request",
        message: 'Body must include a "repo" string, e.g. { "repo": "owner/repo" }',
      },
      400,
    );
  }

  const coord = parseCoordinate(repoInput);
  if (!coord) {
    return c.json(
      {
        error: "bad_request",
        message: `Cannot parse "${repoInput}" as a github owner/repo coordinate`,
      },
      400,
    );
  }

  const pathInput = typeof body?.path === "string" && body.path.trim() ? body.path.trim() : null;

  const sourceRaw = typeof body?.source === "string" ? body.source.trim() : "auto";
  if (!(PARSE_SOURCES as readonly string[]).includes(sourceRaw)) {
    return c.json(
      {
        error: "bad_request",
        message: `Invalid "source": ${sourceRaw}. Use one of: ${PARSE_SOURCES.join(", ")}`,
      },
      400,
    );
  }
  // A path names a file, so it forces the changelog_file source.
  const source: ChangelogParseSource = pathInput
    ? "changelog_file"
    : (sourceRaw as ChangelogParseSource);

  const { org: owner, repo } = coord;
  const token = (await getSecret(c.env.GITHUB_TOKEN)) ?? undefined;
  const headers = buildGitHubHeaders(token, RELEASES_BOT_UA);

  const repoStatus = await classifyRepoStatus({ owner, repo }, headers.apiHeaders);
  if (repoStatus.kind !== "ok") {
    return c.json(repoStatus.body, repoStatus.status);
  }

  const cache = createListingCache();
  let githubRequests = 1; // precheck

  let resolvedSource: "github_releases" | "changelog_file" | null = null;
  let releases: ParsedChangelogRelease[] = [];
  // Set only when github_releases resolves: did we hit the single-page cap?
  let releasesCapped = false;
  let file: z.infer<typeof ChangelogParseFileSchema> | null = null;
  let format: z.infer<typeof ChangelogParseResponseSchema>["format"] = null;
  let headingsScanned = 0;
  let skipped = 0;
  let downloadedBytes = 0;
  // Sub-call failures recorded for the log in auto mode (forced modes return early).
  let releasesFailed = false;
  let fileErrorStatus: number | null = null;

  const runReleases = async () => {
    githubRequests++;
    return fetchGitHubReleases(owner, repo, headers.apiHeaders);
  };

  const runFile = async () => {
    const before = cache.requests;
    const outcome = await resolveChangelogFile(owner, repo, headers, cache, pathInput);
    // discovery listing/tree calls + the single raw body fetch (only attempted
    // once a file was selected — i.e. not on a not_found outcome).
    githubRequests += cache.requests - before + (outcome.kind === "not_found" ? 0 : 1);
    return outcome;
  };

  if (source === "changelog_file") {
    const outcome = await runFile();
    if (outcome.kind === "error") {
      return c.json(
        {
          error: "github_upstream_error",
          message: `Failed to fetch the changelog file for ${owner}/${repo} (status ${outcome.status})`,
        },
        upstreamStatus(outcome.status),
      );
    }
    if (outcome.kind === "not_found") {
      // An explicit path the caller asserted must exist is a 404; an absent
      // root changelog is just "nothing to show".
      if (pathInput) {
        return c.json(
          {
            error: "not_found",
            message: `No changelog file at "${pathInput}" in ${owner}/${repo}`,
          },
          404,
        );
      }
    } else {
      file = outcome.file;
      downloadedBytes = outcome.bytes;
      format = outcome.result.format;
      headingsScanned = outcome.result.headingsScanned;
      skipped = outcome.result.skipped;
      if (outcome.result.parsable) {
        resolvedSource = "changelog_file";
        releases = outcome.result.releases;
      }
    }
  } else if (source === "github_releases") {
    const rel = await runReleases();
    if (rel.failed) {
      return c.json(
        {
          error: "github_upstream_error",
          message: `Failed to fetch GitHub Releases for ${owner}/${repo}`,
        },
        502,
      );
    }
    if (rel.releases.length > 0) {
      resolvedSource = "github_releases";
      releases = rel.releases;
      releasesCapped = rel.capped;
    }
  } else {
    // auto: prefer GitHub Releases with non-trivial bodies, else CHANGELOG.md,
    // else any releases that exist (thin), else nothing. Sub-call failures here
    // degrade gracefully — the viewer still tries the other source — and are
    // only logged, never surfaced (forced modes above surface them instead).
    const rel = await runReleases();
    releasesFailed = rel.failed;
    const hasBody = rel.releases.some((r) => r.content.trim().length > 0);
    if (rel.releases.length > 0 && hasBody) {
      resolvedSource = "github_releases";
      releases = rel.releases;
      releasesCapped = rel.capped;
    } else {
      const outcome = await runFile();
      if (outcome.kind === "error") fileErrorStatus = outcome.status;
      if (outcome.kind === "ok") {
        file = outcome.file;
        downloadedBytes = outcome.bytes;
        format = outcome.result.format;
        headingsScanned = outcome.result.headingsScanned;
        skipped = outcome.result.skipped;
        if (outcome.result.parsable) {
          resolvedSource = "changelog_file";
          releases = outcome.result.releases;
        }
      }
      if (resolvedSource === null && rel.releases.length > 0) {
        // Releases exist but are body-less; better than nothing.
        resolvedSource = "github_releases";
        releases = rel.releases;
        releasesCapped = rel.capped;
        file = null;
        format = null;
      }
    }
  }

  const stats = {
    releasesParsed: releases.length,
    headingsScanned,
    skipped,
    githubRequests,
    bytes: resolvedSource === "changelog_file" ? downloadedBytes : 0,
    elapsedMs: Date.now() - startedAt,
  };

  logEvent("info", {
    component: "changelog-parse-experiment",
    event: "parsed",
    repo: `${owner}/${repo}`,
    source: resolvedSource,
    // auto-mode degradation diagnostics (false/null in forced modes, which return early on failure)
    releasesFailed,
    fileErrorStatus,
    ...stats,
  });

  return c.json({
    repo: `${owner}/${repo}`,
    source: resolvedSource,
    parsable: releases.length > 0,
    capped: resolvedSource === "github_releases" ? releasesCapped : false,
    format: resolvedSource === "changelog_file" ? format : null,
    file: resolvedSource === "changelog_file" ? file : null,
    releases,
    stats,
  });
};

export const changelogRoutes = new Hono<Env>();
changelogRoutes.post("/changelog/fetch", fetchChangelogsRoute, fetchChangelogsHandler);
changelogRoutes.post("/changelog/parse", parseChangelogRoute, parseChangelogHandler);
