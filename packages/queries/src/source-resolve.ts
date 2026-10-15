/**
 * Source identifier resolution that never picks an arbitrary row when a slug
 * is shared across orgs (#2525).
 *
 * - `src_…` ids are globally unique.
 * - `org/slug` coordinates are scoped to that org.
 * - A bare slug with an org hint resolves only inside that org.
 * - A bare slug with no org hint resolves only when exactly one live source
 *   has it; several matches come back as `ambiguous` for the caller to reject.
 */
import type { AnyDb } from "@releases/lib/db";
import {
  findSourceById,
  findSourceForOrgSlug,
  isSourceId,
  listSourcesBySlug,
  type SourceRow,
} from "./entities.js";
import { findOrgByAnyIdentifier, type OrgLookupRow } from "./orgs.js";

export interface SourceCandidate {
  id: string;
  slug: string;
  orgSlug: string;
}

export type SourceResolution =
  | { status: "found"; source: SourceRow; via: "id" | "coordinate" | "org" | "bare-slug" }
  | { status: "not_found" }
  | { status: "ambiguous"; slug: string; candidates: SourceCandidate[] }
  | { status: "org_mismatch"; message: string };

function toCandidates(
  matches: { row: { id: string; slug: string }; orgSlug: string }[],
): SourceCandidate[] {
  return matches
    .map((match) => ({ id: match.row.id, slug: match.row.slug, orgSlug: match.orgSlug }))
    .toSorted((a, b) => `${a.orgSlug}/${a.slug}`.localeCompare(`${b.orgSlug}/${b.slug}`));
}

function coordinateOf(identifier: string): { org: string; slug: string } | null {
  if (isSourceId(identifier)) return null;
  const slash = identifier.indexOf("/");
  if (slash <= 0 || slash >= identifier.length - 1) return null;
  return { org: identifier.slice(0, slash), slug: identifier.slice(slash + 1) };
}

/**
 * Resolve one source identifier. `org` (already looked up) scopes bare slugs
 * and rejects an id or coordinate that belongs to a different org.
 */
export async function resolveSourceIdentifier(
  db: AnyDb,
  identifier: string,
  opts?: { org?: OrgLookupRow | null },
): Promise<SourceResolution> {
  const id = identifier.trim();
  if (!id) return { status: "not_found" };
  const org = opts?.org ?? null;

  if (isSourceId(id)) {
    const source = await findSourceById(db, id);
    if (!source) return { status: "not_found" };
    if (org && source.orgId !== org.id) {
      return {
        status: "org_mismatch",
        message: `Source ${source.id} does not belong to organization ${org.slug}`,
      };
    }
    return { status: "found", source, via: "id" };
  }

  const coordinate = coordinateOf(id);
  if (coordinate) {
    const source = await findSourceForOrgSlug(db, coordinate.org, coordinate.slug);
    if (!source) return { status: "not_found" };
    if (org && source.orgId !== org.id) {
      return {
        status: "org_mismatch",
        message: `Coordinate ${coordinate.org}/${coordinate.slug} is not a source of organization ${org.slug}`,
      };
    }
    return { status: "found", source, via: "coordinate" };
  }

  if (org) {
    const source = await findSourceForOrgSlug(db, org.id, id);
    if (!source) return { status: "not_found" };
    return { status: "found", source, via: "org" };
  }

  const matches = await listSourcesBySlug(db, id);
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length === 1) return { status: "found", source: matches[0]!.row, via: "bare-slug" };
  return { status: "ambiguous", slug: id, candidates: toCandidates(matches) };
}

/** Org id, slug, domain, or case-insensitive name. Null when nothing matches. */
export async function resolveOrgHint(
  db: AnyDb,
  hint: string | null | undefined,
): Promise<OrgLookupRow | null> {
  const trimmed = hint?.trim();
  if (!trimmed) return null;
  return findOrgByAnyIdentifier(db, trimmed);
}
