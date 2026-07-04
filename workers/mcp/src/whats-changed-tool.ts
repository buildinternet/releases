import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import type { WhatsChangedResponse } from "@buildinternet/releases-api-types";
import type { Env } from "./mcp-agent.js";

/**
 * `whats_changed` tool (#1697) — the agent-native wedge: given a package and a
 * `from`/`to` version, return the changelog entries in `(from, to]` with
 * summaries + breaking-change verdicts. A read-only proxy to the API worker's
 * `GET /v1/whats-changed`, which owns the resolution + token-budgeting (single
 * source of truth — the tool just renders). Public read; no token forwarded.
 */

const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

type ToolReturn = { content: [{ type: "text"; text: string }]; isError?: boolean };

function text(body: string, isError = false): ToolReturn {
  return { content: [{ type: "text" as const, text: body }], isError };
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
function renderResolved(r: WhatsChangedResponse): string {
  const head = `${r.package}: ${r.entries.length} release${r.entries.length === 1 ? "" : "s"} from ${r.from} → ${r.to}`;
  if (r.entries.length === 0) {
    return `${head}\n\nNo releases found in that range (the versions may be adjacent, reversed, or outside the tracked history).`;
  }
  const lines = r.entries.map((e) => {
    const flag =
      e.breaking === "major" || e.breaking === "minor" ? ` [BREAKING: ${e.breaking}]` : "";
    const when = e.publishedAt ? ` (${e.publishedAt.slice(0, 10)})` : "";
    const head = `- ${e.version ?? "?"}${when}${flag}: ${e.title ?? "(untitled)"}`;
    const summary = e.summary && e.summary !== e.title ? `\n    ${e.summary}` : "";
    const migration = e.migrationNotes ? `\n    ↳ migration: ${e.migrationNotes}` : "";
    const link = e.webUrl ? `\n    ${e.webUrl}` : "";
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
      },
    },
    async ({ package: pkg, from, to, ecosystem }) => {
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
        return text(renderResolved(r));
      } catch (err) {
        logEvent("error", { component: "mcp-whats-changed", event: "whats-changed-failed", err });
        return text("whats_changed failed (internal error).", true);
      }
    },
  );
}
