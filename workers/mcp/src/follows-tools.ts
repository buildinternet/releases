import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSecret } from "@releases/lib/secrets";
import { getEntityType } from "@buildinternet/releases-core/id";
import { logEvent } from "@releases/lib/log-event";
import { buildCursorMeta } from "./lib/pagination.js";
import type { Env } from "./mcp-agent.js";

/**
 * Per-user follows tools (#1520) — `follow` / `unfollow` / `list_follows` /
 * `get_personalized_feed`. Unlike every other tool on this server (read-only
 * against the registry DB), these act on the CALLER'S account, so they require a
 * USER principal and proxy through the API worker's `/v1/me/*` routes carrying
 * the caller's own credential. A `relu_` user key or an OAuth JWT resolves to a
 * user; anonymous / machine (`relk_`) / root callers do NOT and are refused with
 * a clear message. The API is the source of truth — it re-verifies the forwarded
 * credential and maps it to the user — so these tools never hold a user id.
 */

const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/** A `tools/call` result. `isError` surfaces failures to the model as text. */
type ToolReturn = { content: [{ type: "text"; text: string }]; isError?: boolean };

function text(body: string, isError = false): ToolReturn {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/** Shared message when the caller has no user identity to act as. */
function userRequired(): ToolReturn {
  return text(
    "Following requires a signed-in user. Authenticate with a `relu_…` user API key " +
      "or a 'Sign in with Releases' OAuth token (Authorization: Bearer …). Anonymous, " +
      "machine (`relk_…`), and root credentials have no follows.",
    true,
  );
}

/**
 * Call a `/v1/me/*` route on the API worker as the user, forwarding `userToken`.
 * Returns the parsed JSON + status, or `status: 0` when the API binding is
 * absent (local dev). Mirrors `maybeLookup`'s service-binding call, including the
 * staging-gate header so service-bound requests clear the staging access gate.
 */
async function callMe(
  env: Env,
  userToken: string,
  path: string,
  init: { method: string; body?: string },
): Promise<{ status: number; json: unknown }> {
  if (!env.API) return { status: 0, json: null };
  const headers: Record<string, string> = { Authorization: `Bearer ${userToken}` };
  if (init.body) headers["content-type"] = "application/json";
  const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
  if (stagingKey) headers[STAGING_KEY_HEADER] = stagingKey;
  const res = await env.API.fetch(
    new Request(`https://internal${path}`, { method: init.method, headers, body: init.body }),
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body (empty 204 etc.) — leave json null
  }
  return { status: res.status, json };
}

/** Resolve a follow-target id to `{ targetType, targetId }`, or null if not a typed entity id. */
function asFollowTarget(
  entity: string,
): { targetType: "org" | "product"; targetId: string } | null {
  const t = getEntityType(entity.trim());
  if (t === "org") return { targetType: "org", targetId: entity.trim() };
  if (t === "product") return { targetType: "product", targetId: entity.trim() };
  return null;
}

const FOLLOW_HINTS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const READ_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Minimal shapes of the `/v1/me/*` JSON we render (a subset of the wire types). */
interface FollowRow {
  targetType: "org" | "product";
  targetId: string;
  name: string;
  slug: string;
  orgSlug: string | null;
}
interface FeedItem {
  id: string;
  title: string;
  titleShort?: string | null;
  titleGenerated?: string | null;
  publishedAt?: string | null;
  product?: { name?: string | null } | null;
  source: { name: string };
}

export function registerFollowsTools(
  server: McpServer,
  env: Env,
  opts: { userToken: string | null },
) {
  const { userToken } = opts;

  server.registerTool(
    "follow",
    {
      title: "Follow",
      annotations: { title: "Follow", ...FOLLOW_HINTS },
      description: [
        "Follow an organization or a product so it appears in your personalized feed (`get_personalized_feed`). Following an organization implicitly includes all of its products.",
        "",
        "Requires a signed-in user (a `relu_` user key or an OAuth token). `entity` is a typed id — an `org_…` id or a `prod_…` id — as returned by `search`, `get_organization`, or `get_catalog_entry`. Idempotent: following something you already follow is a no-op.",
      ].join("\n"),
      inputSchema: {
        entity: z
          .string()
          .describe("Entity to follow — an `org_…` or `prod_…` id (from search / get_* results)."),
      },
    },
    async ({ entity }) => {
      if (!userToken) return userRequired();
      const target = asFollowTarget(entity);
      if (!target)
        return text(
          `'${entity}' is not a followable id. Pass an \`org_…\` or \`prod_…\` id (from search / get_organization / get_catalog_entry).`,
          true,
        );
      try {
        const { status } = await callMe(env, userToken, "/v1/me/follows", {
          method: "POST",
          body: JSON.stringify(target),
        });
        if (status === 0) return text("Follows are unavailable in this environment.", true);
        if (status === 201) return text(`Now following ${target.targetId}.`);
        if (status === 200) return text(`Already following ${target.targetId}.`);
        if (status === 404)
          return text(`No ${target.targetType} found for id ${target.targetId}.`, true);
        if (status === 401) return userRequired();
        return text(`Failed to follow (HTTP ${status}).`, true);
      } catch (err) {
        logEvent("error", { component: "mcp-follows", event: "follow-failed", err });
        return text("Failed to follow (internal error).", true);
      }
    },
  );

  server.registerTool(
    "unfollow",
    {
      title: "Unfollow",
      annotations: { title: "Unfollow", ...FOLLOW_HINTS },
      description: [
        "Stop following an organization or product. Requires a signed-in user. `entity` is an `org_…` or `prod_…` id. Idempotent: unfollowing something you don't follow is a no-op.",
      ].join("\n"),
      inputSchema: {
        entity: z.string().describe("Entity to unfollow — an `org_…` or `prod_…` id."),
      },
    },
    async ({ entity }) => {
      if (!userToken) return userRequired();
      const target = asFollowTarget(entity);
      if (!target) return text(`'${entity}' is not a followable id.`, true);
      try {
        const { status } = await callMe(
          env,
          userToken,
          `/v1/me/follows/${target.targetType}/${encodeURIComponent(target.targetId)}`,
          { method: "DELETE" },
        );
        if (status === 0) return text("Follows are unavailable in this environment.", true);
        if (status === 200) return text(`Unfollowed ${target.targetId}.`);
        if (status === 401) return userRequired();
        return text(`Failed to unfollow (HTTP ${status}).`, true);
      } catch (err) {
        logEvent("error", { component: "mcp-follows", event: "unfollow-failed", err });
        return text("Failed to unfollow (internal error).", true);
      }
    },
  );

  server.registerTool(
    "list_follows",
    {
      title: "List follows",
      annotations: { title: "List follows", ...READ_HINTS },
      description:
        "List the organizations and products you follow (newest first). Requires a signed-in user.",
      inputSchema: {},
    },
    async () => {
      if (!userToken) return userRequired();
      try {
        const { status, json } = await callMe(env, userToken, "/v1/me/follows", { method: "GET" });
        if (status === 0) return text("Follows are unavailable in this environment.", true);
        if (status === 401) return userRequired();
        if (status !== 200) return text(`Failed to load follows (HTTP ${status}).`, true);
        const follows = (json as { follows?: FollowRow[] }).follows ?? [];
        if (follows.length === 0) return text("You're not following anything yet.");
        const lines = follows.map((f) => {
          const coord = f.targetType === "product" && f.orgSlug ? `${f.orgSlug}/${f.slug}` : f.slug;
          return `- ${f.name} (${f.targetType} · ${coord}) — ${f.targetId}`;
        });
        return text(`Following ${follows.length}:\n${lines.join("\n")}`);
      } catch (err) {
        logEvent("error", { component: "mcp-follows", event: "list-failed", err });
        return text("Failed to load follows (internal error).", true);
      }
    },
  );

  server.registerTool(
    "get_personalized_feed",
    {
      title: "Get personalized feed",
      annotations: { title: "Get personalized feed", ...READ_HINTS },
      description: [
        "Your personalized release feed — recent releases from the organizations and products you follow, newest first. Requires a signed-in user. Same item shape as `get_latest_releases`, scoped to your follows.",
        "",
        "Cursor-paginated: pass `cursor` from a prior response's `_meta.pagination.nextCursor` and optional `limit` (1–100, default 30).",
      ].join("\n"),
      inputSchema: {
        cursor: z
          .string()
          .optional()
          .describe("Opaque cursor from a previous page's `_meta.pagination.nextCursor`."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Entries per page (1–100). Defaults to 30."),
      },
    },
    async ({ cursor, limit }) => {
      if (!userToken) return userRequired();
      try {
        const qs = new URLSearchParams();
        if (cursor) qs.set("cursor", cursor);
        if (limit) qs.set("limit", String(limit));
        const suffix = qs.toString() ? `?${qs}` : "";
        const { status, json } = await callMe(env, userToken, `/v1/me/feed${suffix}`, {
          method: "GET",
        });
        if (status === 0) return text("The feed is unavailable in this environment.", true);
        if (status === 401) return userRequired();
        if (status !== 200) return text(`Failed to load your feed (HTTP ${status}).`, true);
        const body = json as {
          items?: FeedItem[];
          pagination?: { nextCursor: string | null; limit: number };
        };
        const items = body.items ?? [];
        const nextCursor = body.pagination?.nextCursor ?? null;
        const pageLimit = body.pagination?.limit ?? limit ?? 30;
        const hasMore = nextCursor !== null;
        const cursorMeta = buildCursorMeta({
          returned: items.length,
          limit: pageLimit,
          hasMore,
          nextCursor,
        });
        if (items.length === 0)
          return {
            content: [
              {
                type: "text" as const,
                text: "No recent releases from the organizations and products you follow.",
              },
            ],
            _meta: { pagination: cursorMeta },
          };
        const lines = items.map((it) => {
          const title = it.titleShort ?? it.titleGenerated ?? it.title;
          const by = it.product?.name ?? it.source.name;
          const when = it.publishedAt ? ` · ${it.publishedAt.slice(0, 10)}` : "";
          return `- ${title} — ${by}${when} (${it.id})`;
        });
        return {
          content: [
            { type: "text" as const, text: `Your feed (${items.length}):\n${lines.join("\n")}` },
          ],
          _meta: { pagination: cursorMeta },
        };
      } catch (err) {
        logEvent("error", { component: "mcp-follows", event: "feed-failed", err });
        return text("Failed to load your feed (internal error).", true);
      }
    },
  );
}
