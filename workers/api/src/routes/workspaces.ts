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
import { authOrganization, authMember } from "../db/schema-auth.js";
import type { Env } from "../index.js";
import { PatchWorkspaceProfileBodySchema } from "@buildinternet/releases-api-types";
import { requireFollowsPrincipal } from "../middleware/auth.js";
import { respondError } from "../lib/error-response.js";
import {
  type ReleasesError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "@releases/lib/releases-error";

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
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const [row] = await db
    .select({ role: authMember.role })
    .from(authMember)
    .innerJoin(authOrganization, eq(authMember.organizationId, authOrganization.id))
    .where(and(eq(authMember.organizationId, workspaceId), eq(authMember.userId, userId)))
    .limit(1);
  if (!row) return { ok: false, status: 404 };
  if (!row.role || !MANAGER_ROLES.has(row.role)) return { ok: false, status: 403 };
  return { ok: true };
}

function gateResponse(gate: { ok: false; status: 403 | 404 }): ReleasesError {
  return gate.status === 403
    ? new ForbiddenError("Owner or admin required")
    : new NotFoundError("Workspace not found");
}

export const workspaceProfileHandlers = new Hono<Env>();

workspaceProfileHandlers.get("/workspaces/:workspaceId/profile", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const workspaceId = c.req.param("workspaceId");
  const db = createDb(c.env.DB);

  const [org] = await db
    .select({ logo: authOrganization.logo, metadata: authOrganization.metadata })
    .from(authOrganization)
    .innerJoin(authMember, eq(authMember.organizationId, authOrganization.id))
    .where(and(eq(authOrganization.id, workspaceId), eq(authMember.userId, session.user.id)))
    .limit(1);
  if (!org) return respondError(c, new NotFoundError("Workspace not found"));

  return c.json({
    workspaceId,
    logo: org.logo ?? null,
    profile: parseWorkspaceProfile(org.metadata),
  });
});

workspaceProfileHandlers.patch(
  "/workspaces/:workspaceId/profile",
  validateJson(PatchWorkspaceProfileBodySchema),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const workspaceId = c.req.param("workspaceId");
    const body = c.req.valid("json");
    const db = createDb(c.env.DB);

    const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
    if (!gate.ok) return respondError(c, gateResponse(gate));

    const [org] = await db
      .select({ metadata: authOrganization.metadata, logo: authOrganization.logo })
      .from(authOrganization)
      .where(eq(authOrganization.id, workspaceId))
      .limit(1);
    if (!org) return respondError(c, new NotFoundError("Workspace not found"));

    const normalized = normalizeProfilePatch(body);
    if (!normalized.ok) {
      return respondError(c, new ValidationError(normalized.message, { code: "bad_request" }));
    }

    const metadata = mergeWorkspaceMetadata(org.metadata, normalized.patch);
    await db.update(authOrganization).set({ metadata }).where(eq(authOrganization.id, workspaceId));

    return c.json({
      workspaceId,
      logo: org.logo ?? null,
      profile: parseWorkspaceProfile(metadata),
    });
  },
);

workspaceProfileHandlers.post("/workspaces/:workspaceId/avatar", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  if (!c.env.MEDIA) {
    return respondError(
      c,
      new ServiceUnavailableError("Media storage is not configured", {
        code: "service_unavailable",
      }),
    );
  }

  const workspaceId = c.req.param("workspaceId");
  const db = createDb(c.env.DB);
  const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
  if (!gate.ok) return respondError(c, gateResponse(gate));

  const file = await readAvatarFile(c);
  if ("error" in file) {
    // 413 keeps the payload_too_large code (status still normalizes to 400 via
    // ValidationError); other upload failures are generic bad_request.
    return respondError(
      c,
      new ValidationError(file.error, {
        code: file.status === 413 ? "payload_too_large" : "bad_request",
      }),
    );
  }

  const result = await ingestAvatarFromBuffer({
    buf: file.buf,
    contentType: file.contentType,
    keyStem: `workspaces/${workspaceId}`,
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
    .where(eq(authOrganization.id, workspaceId));

  return c.json({
    avatarUrl: result.avatarUrl,
    key: result.key,
    width: result.width,
    height: result.height,
  });
});

/** Session-or-Bearer principal gate, then workspace profile/avatar handlers. */
export const workspaceRoutes = new Hono<Env>();
workspaceRoutes.use("/workspaces/*", requireFollowsPrincipal);
workspaceRoutes.route("/", workspaceProfileHandlers);
