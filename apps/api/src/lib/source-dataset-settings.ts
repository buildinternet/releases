import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import { SourceDatasetSettingsSchema } from "@buildinternet/releases-api-types";
import { ForbiddenError, ValidationError } from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import type { AnyDb } from "../db.js";
import type { Env } from "../index.js";
import { isValidBearerAuth, resolveAuthIdentity } from "../middleware/auth.js";
import { respondError } from "./error-response.js";
import { notifyWebRevalidatePaths } from "./web-revalidate.js";

export async function validateDatasetPatch(c: Context<Env>, patch: Record<string, unknown>) {
  if (!Object.hasOwn(patch, "dataset")) return null;
  if (!(await isValidBearerAuth(c)))
    return respondError(c, new ForbiddenError("Admin scope required to change dataset settings."));
  if (patch.dataset !== null) {
    const parsed = SourceDatasetSettingsSchema.safeParse(patch.dataset);
    if (!parsed.success)
      return respondError(c, new ValidationError(parsed.error.message, { code: "bad_request" }));
    patch.dataset = parsed.data;
  }
  return null;
}

export function isObjectSourceMetadata(metadata: string | null | undefined): boolean {
  try {
    const value: unknown = JSON.parse(metadata ?? "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function rawDatasetValue(metadata: string | null | undefined): unknown {
  try {
    return JSON.parse(metadata ?? "{}")?.dataset ?? null;
  } catch {
    return null;
  }
}

export async function datasetSettingsChanged(
  c: Context<Env>,
  db: AnyDb,
  source: { id: string; slug: string; orgId: string | null },
) {
  const identity = await resolveAuthIdentity(c);
  logEvent("info", {
    component: "source-dataset-settings",
    event: "changed",
    sourceId: source.id,
    actor:
      identity?.kind === "root"
        ? "root-key"
        : identity?.kind === "token"
          ? identity.tokenId
          : "unknown",
  });
  const org = source.orgId
    ? await db
        .select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, source.orgId))
        .get()
    : null;
  const paths = ["/sitemap-orgs.xml"];
  if (org)
    paths.push(
      `/${org.slug}/${source.slug}`,
      `/${org.slug}/${source.slug}/highlights`,
      `/${org.slug}/${source.slug}/changelog`,
    );
  c.executionCtx.waitUntil(
    notifyWebRevalidatePaths(c.env, paths, { component: "source-dataset-settings" }),
  );
}
