import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import { chunkArray, IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import {
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
  isImportanceScore,
} from "@buildinternet/releases-core/importance";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import type { WhatsChangedResponse } from "@buildinternet/releases-api-types";
import { createDb } from "./db.js";
import type { Env } from "./mcp-agent.js";

/**
 * `whats_changed` tool (#1697) — the agent-native wedge: given a package and a
 * `from`/`to` version, return the changelog entries in `(from, to]` with
 * summaries + breaking-change verdicts. A read-only proxy to the API worker's
 * `GET /v1/whats-changed`, which owns the resolution + token-budgeting (single
 * source of truth — the tool just renders). Public read; no token forwarded.
 *
 * `importance` isn't part of the REST `/v1/whats-changed` response (that route
 * only budgets/orders by version and token cost), so it can't be applied by
 * simply forwarding a query param the way `get_latest_releases`' own D1 query
 * does. Instead, once the API resolves the `(from, to]` range, this tool runs
 * a small direct D1 lookup — `releases.importance` keyed by `(source_id,
 * version)` for exactly the resolved versions — to attach a score to each
 * entry and apply `minImportance` locally. Same NULL semantics as the REST
 * filter: an unscored (`null`) entry never passes a `minImportance` filter.
 */

const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

type ToolReturn = { content: [{ type: "text"; text: string }]; isError?: boolean };

function text(body: string, isError = false): ToolReturn {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/** One resolved entry with its AI-scored importance merged in (null when unscored). */
type EntryWithImportance = WhatsChangedResponse["entries"][number] & { importance: number | null };

/**
 * Look up `releases.importance` for the resolved entries by `(source_id,
 * version)` and merge it onto each entry. Best-effort: an entry with a null
 * `version` (shouldn't normally happen for a resolved range) or no matching
 * row gets `importance: null` — the same "unscored" value a NULL column read
 * would produce.
 *
 * The IN-list is chunked: the API budgets a range at up to `MAX_ENTRIES` (312)
 * entries, while D1 caps a prepared statement at `D1_MAX_BINDINGS` (100) bound
 * parameters. A wide range (`from` an old tag, `to` latest) would otherwise
 * throw "too many SQL variables" for every caller, filtered or not.
 */
async function attachImportance(
  env: Env,
  sourceId: string,
  entries: WhatsChangedResponse["entries"],
): Promise<EntryWithImportance[]> {
  const versions = [
    ...new Set(entries.map((e) => e.version).filter((v): v is string => v != null)),
  ];
  if (versions.length === 0) return entries.map((e) => ({ ...e, importance: null }));

  const byVersion = new Map<string, number | null>();
  const db = createDb(env.DB);
  // `sourceId` takes one bind, so each chunk stays at IN_ARRAY_CHUNK_SIZE + 1.
  for (const chunk of chunkArray(versions, IN_ARRAY_CHUNK_SIZE)) {
    const rows = await db
      .select({ version: releases.version, importance: releases.importance })
      .from(releases)
      .where(and(eq(releases.sourceId, sourceId), inArray(releases.version, chunk)));
    for (const row of rows) {
      if (row.version != null) byVersion.set(row.version, row.importance);
    }
  }
  return entries.map((e) => ({
    ...e,
    importance: e.version != null ? (byVersion.get(e.version) ?? null) : null,
  }));
}

const READ_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** GET a public API route over the service binding. Carries the staging-gate
 *  header so service-bound requests clear `api-staging`'s access gate (inert in
 *  prod). `status: 0` when the binding is absent (local dev). */
async function callApi(env: Env, path: string): Promise<{ status: number; json: unknown }> {
  if (!env.API) return { status: 0, json: null };
  const headers: Record<string, string> = {};
  const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
  if (stagingKey) headers[STAGING_KEY_HEADER] = stagingKey;
  const res = await env.API.fetch(
    new Request(`https://internal${path}`, { method: "GET", headers }),
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body — leave null
  }
  return { status: res.status, json };
}

/** Render the resolved upgrade range as a compact, agent-readable block. */
function renderResolved(r: {
  package: string;
  from: string;
  to: string;
  entries: EntryWithImportance[];
  truncated: boolean;
}): string {
  const head = `${r.package}: ${r.entries.length} release${r.entries.length === 1 ? "" : "s"} from ${r.from} → ${r.to}`;
  if (r.entries.length === 0) {
    return `${head}\n\nNo releases found in that range (the versions may be adjacent, reversed, or outside the tracked history).`;
  }
  const lines = r.entries.map((e) => {
    const flag =
      e.breaking === "major" || e.breaking === "minor" ? ` [BREAKING: ${e.breaking}]` : "";
    const importanceFlag = e.importance != null ? ` [Importance: ${e.importance}/5]` : "";
    const when = e.publishedAt ? ` (${e.publishedAt.slice(0, 10)})` : "";
    const head = `- ${e.version ?? "?"}${when}${flag}${importanceFlag}: ${e.title ?? "(untitled)"}`;
    const summary = e.summary && e.summary !== e.title ? `\n    ${e.summary}` : "";
    const migration = e.migrationNotes ? `\n    ↳ migration: ${e.migrationNotes}` : "";
    const link = e.webUrl ? `\n    Web: ${e.webUrl}` : "";
    return `${head}${summary}${migration}${link}`;
  });
  const breakingCount = r.entries.filter(
    (e) => e.breaking === "major" || e.breaking === "minor",
  ).length;
  const note = breakingCount > 0 ? ` (${breakingCount} flagged breaking)` : "";
  const trunc = r.truncated
    ? `\n\n(Range truncated to a token budget; newest entries shown. Narrow the from/to range for the full set.)`
    : "";
  return `${head}${note}:\n${lines.join("\n")}${trunc}`;
}

/**
 * Core `whats_changed` logic, factored out of `registerTool`'s callback so
 * it's callable directly from tests without spinning up a full `McpServer`.
 * Re-validates `minImportance`'s range defensively (zod already enforces the
 * bound at the tool's input-schema layer for real MCP callers — see
 * `registerWhatsChangedTool` below).
 */
export async function runWhatsChanged(
  env: Env,
  params: {
    package: string;
    from: string;
    to: string;
    ecosystem?: "npm" | "pypi" | "github";
    minImportance?: number;
  },
): Promise<ToolReturn> {
  const { package: pkg, from, to, ecosystem, minImportance } = params;
  if (minImportance !== undefined && !isImportanceScore(minImportance)) {
    return text(
      `\`minImportance\` must be an integer between ${IMPORTANCE_MIN} and ${IMPORTANCE_MAX}.`,
      true,
    );
  }
  const qs = new URLSearchParams({ package: pkg, from, to });
  if (ecosystem) qs.set("ecosystem", ecosystem);
  try {
    const { status, json } = await callApi(env, `/v1/whats-changed?${qs.toString()}`);
    if (status === 0) return text("whats_changed is unavailable in this environment.", true);
    if (status === 400) {
      const msg = (json as { message?: string })?.message ?? "Invalid request.";
      return text(msg, true);
    }
    if (status !== 200 || !json) return text(`whats_changed failed (HTTP ${status}).`, true);
    const r = json as WhatsChangedResponse;
    if (r.status === "unknown") {
      return text(
        `'${pkg}' isn't a tracked source, so there's no changelog history to diff. Try a GitHub "owner/repo" coordinate (with ecosystem: "github"), or search for the product first. (npm/PyPI package names aren't all mapped to a source yet.)`,
      );
    }

    // `importance` isn't in the REST response — merge it in from D1 (see the
    // module doc comment) so both the render and the `minImportance` filter
    // below see a score per entry, `null` when unscored.
    const entries = r.source
      ? await attachImportance(env, r.source.sourceId, r.entries)
      : r.entries.map((e) => ({ ...e, importance: null }) as EntryWithImportance);

    // `null` (unscored) never passes a `minImportance` filter — mirrors the
    // REST `?minImportance=` predicate (`importance >= ?` excludes NULL).
    const filtered =
      minImportance !== undefined
        ? entries.filter((e) => e.importance != null && e.importance >= minImportance)
        : entries;

    return text(
      renderResolved({
        package: r.package,
        from: r.from,
        to: r.to,
        entries: filtered,
        truncated: r.truncated,
      }),
    );
  } catch (err) {
    logEvent("error", { component: "mcp-whats-changed", event: "whats-changed-failed", err });
    return text("whats_changed failed (internal error).", true);
  }
}

export function registerWhatsChangedTool(server: McpServer, env: Env) {
  server.registerTool(
    "whats_changed",
    {
      title: "What's changed",
      annotations: { title: "What's changed", ...READ_HINTS },
      description: [
        "Given a package and a `from`/`to` version, return the changelog entries between them — `(from, to]`, from exclusive, to inclusive — with summaries and breaking-change verdicts. One call instead of reading N changelog pages to plan an upgrade.",
        "",
        "`package` is a tracked source slug or a GitHub `owner/repo` coordinate (set `ecosystem: \"github\"` for a bare coordinate). Reads already-indexed releases only. If the package isn't in the catalog you'll get a clear 'not tracked' answer (npm/PyPI names may not be mapped to a source yet).",
      ].join("\n"),
      inputSchema: {
        package: z
          .string()
          .describe('Package identifier — a source slug or a GitHub "owner/repo" coordinate.'),
        from: z.string().describe("Version you're upgrading FROM (exclusive)."),
        to: z.string().describe("Version you're upgrading TO (inclusive)."),
        ecosystem: z
          .enum(["npm", "pypi", "github"])
          .optional()
          .describe('Optional resolution hint; "github" enables matching a bare owner/repo.'),
        minImportance: z
          .number()
          .int()
          .min(IMPORTANCE_MIN)
          .max(IMPORTANCE_MAX)
          .optional()
          .describe(
            `Only include entries with an AI-scored \`importance\` >= this value (${IMPORTANCE_MIN}-${IMPORTANCE_MAX}; 5=landmark, 1=housekeeping). Entries with no score (unscored) are excluded when this is set.`,
          ),
      },
    },
    async (params) => runWhatsChanged(env, params),
  );
}
