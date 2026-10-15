/**
 * HTTP-facing wrapper around `@releases/queries/source-resolve` (#2525).
 * A bare slug that matches one source still resolves, with a warning so the
 * caller can be moved to a `src_` id or an `org/slug` coordinate. Several
 * matches are a 409. A named org that has no such source is a 404.
 */
import { logEvent } from "@releases/lib/log-event";
import { ConflictError, NotFoundError, ValidationError } from "@releases/lib/releases-error";
import {
  resolveOrgHint,
  resolveSourceIdentifier,
  type SourceResolution,
} from "@releases/queries/source-resolve";
import { isSourceId } from "@releases/queries/entities";
import type { D1Db } from "../../db.js";

export function sourceResolutionError(
  identifier: string,
  result: SourceResolution,
  orgSlug?: string | null,
): NotFoundError | ConflictError | null {
  switch (result.status) {
    case "found":
      return null;
    case "not_found":
      return new NotFoundError(
        orgSlug
          ? `No source "${identifier}" on organization ${orgSlug}`
          : `Source not found: ${identifier}`,
      );
    case "ambiguous": {
      const listed = result.candidates
        .map((candidate) => `${candidate.orgSlug}/${candidate.slug} (${candidate.id})`)
        .join(", ");
      return new ConflictError(
        `Source slug "${result.slug}" matches ${result.candidates.length} sources: ${listed}. Pass a src_ id or an org/slug coordinate.`,
        { details: { candidates: result.candidates } },
      );
    }
    case "org_mismatch":
      return new ConflictError(result.message);
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

export async function requireResolvedSource(
  db: D1Db,
  identifier: string,
  opts: { component: string; orgIdOrSlug?: string | null },
): Promise<
  { ok: true; sourceId: string; slug: string } | { ok: false; error: NotFoundError | ConflictError }
> {
  const org = opts.orgIdOrSlug ? await resolveOrgHint(db, opts.orgIdOrSlug) : null;
  if (opts.orgIdOrSlug?.trim() && !org) {
    return {
      ok: false,
      error: new NotFoundError(`Organization not found: ${opts.orgIdOrSlug}`),
    };
  }
  const resolved = await resolveSourceIdentifier(db, identifier, { org });
  if (resolved.status === "found" && resolved.via === "bare-slug") {
    logEvent("warn", {
      component: opts.component,
      event: "bare-slug-resolved",
      slug: identifier.trim(),
      sourceId: resolved.source.id,
      orgId: resolved.source.orgId,
    });
  }
  const error = sourceResolutionError(identifier, resolved, org?.slug);
  if (error || resolved.status !== "found") return { ok: false, error: error! };
  return { ok: true, sourceId: resolved.source.id, slug: resolved.source.slug };
}

/**
 * Rewrite update-workflow identifiers to `src_` ids before locks are taken.
 * An explicit `orgId` always scopes. Otherwise `company` scopes when it
 * matches an org (slug, id, domain, or name) — a display label that matches
 * nothing leaves `src_` ids untouched and rejects an ambiguous bare slug.
 */
export async function resolveUpdateSourceIds(
  db: D1Db,
  params: { company?: string; orgId?: string; identifiers: string[] },
): Promise<
  | { ok: true; sourceIds: string[]; orgId?: string }
  | { ok: false; error: NotFoundError | ConflictError | ValidationError }
> {
  let org = null;
  if (params.orgId?.trim()) {
    org = await resolveOrgHint(db, params.orgId);
    if (!org) {
      return { ok: false, error: new NotFoundError(`Organization not found: ${params.orgId}`) };
    }
  } else if (params.company?.trim()) {
    org = await resolveOrgHint(db, params.company);
  }

  const sourceIds: string[] = [];
  for (const ident of params.identifiers) {
    if (typeof ident !== "string" || ident.trim().length === 0) {
      return {
        ok: false,
        error: new ValidationError("sourceIdentifiers must be non-empty strings"),
      };
    }
    const trimmed = ident.trim();
    if (!org && isSourceId(trimmed)) {
      sourceIds.push(trimmed);
      continue;
    }
    const resolved = await resolveSourceIdentifier(db, trimmed, { org });
    if (resolved.status === "found" && resolved.via === "bare-slug") {
      logEvent("warn", {
        component: "workflows-update",
        event: "bare-slug-resolved",
        slug: trimmed,
        sourceId: resolved.source.id,
        orgId: resolved.source.orgId,
      });
    }
    const error = sourceResolutionError(trimmed, resolved, org?.slug);
    if (error || resolved.status !== "found") return { ok: false, error: error! };
    sourceIds.push(resolved.source.id);
  }
  return { ok: true, sourceIds, ...(org ? { orgId: org.id } : {}) };
}
