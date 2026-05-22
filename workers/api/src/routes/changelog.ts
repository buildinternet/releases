/**
 * Experimental: `POST /v1/changelog/fetch` — given a GitHub `owner/repo`
 * coordinate, discover and fetch every CHANGELOG file in the repo (root +
 * monorepo workspace packages) and return an inventory with per-file excerpts
 * plus efficiency stats. **Nothing is persisted** — no D1/KV/R2 writes, no
 * source row required.
 *
 * This is the coordinate-based sibling of the source-scoped changelog probe
 * (`POST /v1/sources/:slug/changelog/probe`): it reuses the same worker-safe
 * discovery planner (`discoverChangelogPaths`) and the shared repo precheck
 * (`classifyRepoStatus`), then does its own lightweight body-fetch loop since
 * the cron fetch path's body fetcher is Node-flavored. Hidden from the
 * production OpenAPI spec; auth-gated as a write (Bearer) like the probe.
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
import { ErrorResponseSchema } from "@buildinternet/releases-api-types";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { classifyRepoStatus } from "../lib/github-repo-status.js";
import type { Env } from "../index.js";

/** Match the cron fetch path's per-source ceiling so the experiment's cost
 *  profile mirrors production. */
const MAX_FILES = 20;
/** A file larger than this would be tail-truncated by the real ingest path; we
 *  download it whole (cost is real) and just flag it. Matches CHANGELOG_MAX_BYTES. */
const MAX_BYTES = 1024 * 1024;
/** How much of each file body to echo back. Newest entries sit at the top of a
 *  conventional changelog, so the head is the useful slice. */
const EXCERPT_CHARS = 2000;

const encoder = new TextEncoder();

const ChangelogFileSchema = z.object({
  path: z.string(),
  filename: z.string(),
  origin: z.enum(["root", "workspace", "override"]),
  url: z.string(),
  rawUrl: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
  excerpt: z.string(),
});

const ChangelogFetchStatsSchema = z.object({
  pathsDiscovered: z.number(),
  filesFetched: z.number(),
  totalBytes: z.number(),
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
    'Experimental. Given a `{ repo: "owner/repo" }` coordinate (or `github:owner/repo`), runs the same CHANGELOG discovery the cron fetch path uses — root listing plus monorepo workspace expansion (`package.json#workspaces`, `pnpm-workspace.yaml`) — then fetches each discovered file and returns an inventory with per-file excerpts plus efficiency stats (`githubRequests`, `totalBytes`, `elapsedMs`). Nothing is written to D1/KV/R2 and no source row is required. Capped at 20 files. Auth: Bearer (write) via `publicReadAuthMiddleware`\'s non-SAFE_METHODS branch. Hidden from the production OpenAPI spec.',
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

  // Tree-search first pass: one recursive Git Trees call instead of a per-dir
  // workspace walk (which falls back automatically on truncation/failure).
  // Caller-owned cache lets us read back the upstream request count after.
  const cache = createListingCache();
  const planned = (await discoverChangelogPathsViaTree(syntheticSource, headers, cache)) ?? [];
  const fetchable = planned.filter((p) => p.exists).slice(0, MAX_FILES);

  const files: z.infer<typeof ChangelogFileSchema>[] = [];
  let bodyFetches = 0;
  let totalBytes = 0;
  let truncatedCount = 0;

  for (const entry of fetchable) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${entry.path}`;
    bodyFetches++;
    let res: Response;
    try {
      // oxlint-disable-next-line no-await-in-loop -- GitHub raw API is rate-limited; fetch sequentially like the cron path
      res = await fetch(rawUrl, { headers: headers.rawHeaders });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    // oxlint-disable-next-line no-await-in-loop -- body read paired with the sequential fetch above
    const text = await res.text();
    const bytes = encoder.encode(text).length;
    const truncated = bytes > MAX_BYTES;
    totalBytes += bytes;
    if (truncated) truncatedCount++;
    const lastSlash = entry.path.lastIndexOf("/");
    const filename = lastSlash === -1 ? entry.path : entry.path.slice(lastSlash + 1);
    files.push({
      path: entry.path,
      filename,
      origin: entry.origin,
      url: `https://github.com/${owner}/${repo}/blob/HEAD/${entry.path}`,
      rawUrl,
      bytes,
      truncated,
      excerpt: text.slice(0, EXCERPT_CHARS),
    });
  }

  const stats = {
    pathsDiscovered: planned.length,
    filesFetched: files.length,
    totalBytes,
    truncatedCount,
    // 1 repo precheck + discovery listings/manifest reads + one raw fetch per file.
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

export const changelogRoutes = new Hono<Env>();
changelogRoutes.post("/changelog/fetch", fetchChangelogsRoute, fetchChangelogsHandler);
