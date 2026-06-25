import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { ingestAvatarFromBuffer } from "../lib/avatar-ingest.js";
import {
  mergeWorkspaceMetadata,
  normalizeProfilePatch,
  parseWorkspaceProfile,
} from "../lib/workspace-profile.js";
import { validateJson } from "../lib/validate.js";
import { authOrganization, authMember, user } from "../db/schema-auth.js";
import type { Env } from "../index.js";
import { PatchWorkspaceProfileBodySchema } from "@buildinternet/releases-api-types";

const MAX_MULTIPART_BYTES = 8 * 1024 * 1024;
const MANAGER_ROLES = new Set(["owner", "admin"]);

async function readAvatarFile(c: {
  req: { formData: () => Promise<FormData> };
}): Promise<
  { buf: ArrayBuffer; contentType: string } | { error: string; status: 400 | 413 | 415 }
> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return { error: "Invalid multipart body", status: 400 };
  }
  const entry = form.get("file");
  if (!(entry instanceof File)) {
    return { error: "file is required", status: 400 };
  }
  if (entry.size > MAX_MULTIPART_BYTES) {
    return { error: `Image exceeds the ${MAX_MULTIPART_BYTES}-byte cap`, status: 413 };
  }
  const contentType = (entry.type || "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  return { buf: await entry.arrayBuffer(), contentType };
}

async function requireWorkspaceManager(
  db: ReturnType<typeof createDb>,
  userId: string,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const [row] = await db
    .select({ role: authMember.role })
    .from(authMember)
    .innerJoin(authOrganization, eq(authMember.organizationId, authOrganization.id))
    .where(and(eq(authMember.organizationId, organizationId), eq(authMember.userId, userId)))
    .limit(1);
  if (!row) return { ok: false, status: 404 };
  if (!row.role || !MANAGER_ROLES.has(row.role)) return { ok: false, status: 403 };
  return { ok: true };
}

function gateResponse(gate: { ok: false; status: 403 | 404 }) {
  return {
    error: gate.status === 403 ? "forbidden" : "not_found",
    message: gate.status === 403 ? "Owner or admin required" : "Workspace not found",
    status: gate.status,
  } as const;
}

export const accountProfileHandlers = new Hono<Env>();

accountProfileHandlers.post("/me/avatar", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  if (!c.env.MEDIA) {
    return c.json({ error: "unavailable", message: "Media storage is not configured" }, 503);
  }

  const file = await readAvatarFile(c);
  if ("error" in file) {
    return c.json({ error: "bad_request", message: file.error }, file.status);
  }

  const result = await ingestAvatarFromBuffer({
    buf: file.buf,
    contentType: file.contentType,
    keyStem: `users/${session.user.id}`,
    bucket: c.env.MEDIA,
    mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
    component: "user-avatar",
  });
  if (!result.ok) {
    return c.json({ error: result.error, message: result.message }, result.status);
  }

  const db = createDb(c.env.DB);
  await db.update(user).set({ image: result.avatarUrl }).where(eq(user.id, session.user.id));

  return c.json({
    avatarUrl: result.avatarUrl,
    key: result.key,
    width: result.width,
    height: result.height,
  });
});

accountProfileHandlers.get("/me/workspaces/:organizationId/profile", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const organizationId = c.req.param("organizationId");
  const db = createDb(c.env.DB);

  const [org] = await db
    .select({ logo: authOrganization.logo, metadata: authOrganization.metadata })
    .from(authOrganization)
    .innerJoin(authMember, eq(authMember.organizationId, authOrganization.id))
    .where(and(eq(authOrganization.id, organizationId), eq(authMember.userId, session.user.id)))
    .limit(1);
  if (!org) return c.json({ error: "not_found", message: "Workspace not found" }, 404);

  return c.json({
    organizationId,
    logo: org.logo ?? null,
    profile: parseWorkspaceProfile(org.metadata),
  });
});

accountProfileHandlers.patch(
  "/me/workspaces/:organizationId/profile",
  validateJson(PatchWorkspaceProfileBodySchema),
  async (c) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
    const organizationId = c.req.param("organizationId");
    const body = c.req.valid("json");
    const db = createDb(c.env.DB);

    const gate = await requireWorkspaceManager(db, session.user.id, organizationId);
    if (!gate.ok) {
      const err = gateResponse(gate);
      return c.json({ error: err.error, message: err.message }, err.status);
    }

    const [org] = await db
      .select({ metadata: authOrganization.metadata, logo: authOrganization.logo })
      .from(authOrganization)
      .where(eq(authOrganization.id, organizationId))
      .limit(1);
    if (!org) return c.json({ error: "not_found", message: "Workspace not found" }, 404);

    const normalized = normalizeProfilePatch(body);
    if (!normalized.ok) {
      return c.json({ error: "bad_request", message: normalized.message }, 400);
    }

    const metadata = mergeWorkspaceMetadata(org.metadata, normalized.patch);
    await db
      .update(authOrganization)
      .set({ metadata })
      .where(eq(authOrganization.id, organizationId));

    return c.json({
      organizationId,
      logo: org.logo ?? null,
      profile: parseWorkspaceProfile(metadata),
    });
  },
);

accountProfileHandlers.post("/me/workspaces/:organizationId/avatar", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  if (!c.env.MEDIA) {
    return c.json({ error: "unavailable", message: "Media storage is not configured" }, 503);
  }

  const organizationId = c.req.param("organizationId");
  const db = createDb(c.env.DB);
  const gate = await requireWorkspaceManager(db, session.user.id, organizationId);
  if (!gate.ok) {
    const err = gateResponse(gate);
    return c.json({ error: err.error, message: err.message }, err.status);
  }

  const file = await readAvatarFile(c);
  if ("error" in file) {
    return c.json({ error: "bad_request", message: file.error }, file.status);
  }

  const result = await ingestAvatarFromBuffer({
    buf: file.buf,
    contentType: file.contentType,
    keyStem: `workspaces/${organizationId}`,
    bucket: c.env.MEDIA,
    mediaOrigin: c.env.MEDIA_ORIGIN ?? "https://media.releases.sh",
    component: "workspace-avatar",
  });
  if (!result.ok) {
    return c.json({ error: result.error, message: result.message }, result.status);
  }

  await db
    .update(authOrganization)
    .set({ logo: result.avatarUrl })
    .where(eq(authOrganization.id, organizationId));

  return c.json({
    avatarUrl: result.avatarUrl,
    key: result.key,
    width: result.width,
    height: result.height,
  });
});
