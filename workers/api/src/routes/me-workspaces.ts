/**
 * Self-serve workspace listing at `/v1/me/workspaces` (#2327).
 *
 * Read-only: creating, renaming, and switching the active workspace stay on
 * Better Auth (`/api/auth/organization/*`). This route exists so the CLI and
 * MCP server — which authenticate by Bearer, not a Better Auth session cookie
 * — can find a workspace id, unblocking workspace webhook support (#2326,
 * buildinternet/releases-cli#406).
 *
 * Gated like the rest of `/me/*`: production mounts these handlers behind
 * `requireFollowsPrincipal` (session, `relu_` key, or OAuth JWT user
 * principal). Handlers still check the session themselves so unit tests can
 * inject one directly, matching the sibling `/me/*` route files.
 */
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { MeWorkspace, MeWorkspacesResponse } from "@buildinternet/releases-api-types";
import type { Env } from "../index.js";
import { createDb } from "../db.js";
import { respondError } from "../lib/error-response.js";
import { errorResponse } from "../lib/openapi-error.js";
import { UnauthorizedError } from "@releases/lib/releases-error";
import { getActiveWorkspaceId, listMemberWorkspaces } from "../queries/workspaces.js";

export const meWorkspaceHandlers = new Hono<Env>();

function jsonBody(description: string, schema: Record<string, unknown>) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

const workspaceSchema: Record<string, unknown> = {
  type: "object",
  required: ["id", "name", "slug", "logo", "role", "active", "createdAt"],
  properties: {
    id: { type: "string", description: "Better Auth organization id." },
    name: { type: "string" },
    slug: { type: "string" },
    logo: { type: "string", nullable: true },
    role: { type: "string", enum: ["owner", "admin", "member"] },
    active: { type: "boolean", description: "The caller's active workspace." },
    createdAt: { type: "string", format: "date-time" },
  },
};

meWorkspaceHandlers.get(
  "/me/workspaces",
  describeRoute({
    tags: ["Account"],
    summary: "List your workspaces",
    description:
      "Workspaces the caller belongs to (Better Auth organization plugin — user tenancy, distinct from the registry orgs). `active` marks the caller's current workspace. Requires a Better Auth session or a user Bearer token (`relu_` or OAuth JWT); machine `relk_` tokens and anonymous callers are refused. Read-only — creating, renaming, and switching workspaces stay on Better Auth.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonBody("The caller's workspaces, ordered by name. Empty when the caller has none.", {
        type: "object",
        required: ["workspaces"],
        properties: { workspaces: { type: "array", items: workspaceSchema } },
      }),
      401: errorResponse("Sign-in required"),
    },
  }),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));

    const db = createDb(c.env.DB);
    const userId = session.user.id;
    const [rows, activeWorkspaceId] = await Promise.all([
      listMemberWorkspaces(db, userId),
      getActiveWorkspaceId(db, userId),
    ]);

    const workspaces: MeWorkspace[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      logo: row.logo,
      role:
        row.role === "owner" || row.role === "admin"
          ? row.role
          : ("member" as const satisfies MeWorkspace["role"]),
      active: row.id === activeWorkspaceId,
      createdAt: row.createdAt.toISOString(),
    }));

    c.header("Cache-Control", "private, no-store");
    const body: MeWorkspacesResponse = { workspaces };
    return c.json(body);
  },
);
