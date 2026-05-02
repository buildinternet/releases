import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { organizationsActive, sourcesActive } from "@buildinternet/releases-core/schema";
import { notOnDemand } from "../queries/shared.js";
import type { createDb } from "../db.js";

type Db = ReturnType<typeof createDb>;

// Escape SQL LIKE wildcards (`%`, `_`, `\`) so the orgSegment is matched
// literally. `parseCoordinate`'s GITHUB_SEGMENT regex allows `_`, which would
// otherwise act as a single-char wildcard and produce false-positive matches.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * One unambiguous "did you mean" match for a github org segment. Returned to
 * /v1/lookups callers so the not_found / empty card can show "from acme: foo,
 * bar, baz" when the specific repo we were asked about doesn't pan out.
 *
 * Ambiguous matches return null — better to show no rail than the wrong rail.
 */
export interface RelatedOrgResult {
  org: { id: string; slug: string; name: string };
  sources: Array<{ id: string; slug: string; name: string; url: string }>;
}

export async function resolveRelatedOrg(
  db: Db,
  orgSegment: string,
): Promise<RelatedOrgResult | null> {
  // Always check URL-based matches first to detect ambiguity across all orgs
  // that share the same GitHub org namespace.
  const urlPattern = `%github.com/${escapeLike(orgSegment)}/%`;
  const orgsByUrl = await db
    .selectDistinct({
      id: organizationsActive.id,
      slug: organizationsActive.slug,
      name: organizationsActive.name,
    })
    .from(organizationsActive)
    .innerJoin(sourcesActive, eq(sourcesActive.orgId, organizationsActive.id))
    .where(
      and(
        sql`${sourcesActive.url} LIKE ${urlPattern} ESCAPE '\\'`,
        notOnDemand(organizationsActive.discovery),
      ),
    )
    .limit(2);

  let candidates = orgsByUrl;

  // If no URL matches, fall back to exact slug match.
  if (candidates.length === 0) {
    const exactSlugMatches = await db
      .select({
        id: organizationsActive.id,
        slug: organizationsActive.slug,
        name: organizationsActive.name,
      })
      .from(organizationsActive)
      .where(
        and(eq(organizationsActive.slug, orgSegment), notOnDemand(organizationsActive.discovery)),
      )
      .limit(2);
    candidates = exactSlugMatches;
  }

  if (candidates.length !== 1) return null;
  const org = candidates[0]!;

  const orgSources = await db
    .select({
      id: sourcesActive.id,
      slug: sourcesActive.slug,
      name: sourcesActive.name,
      url: sourcesActive.url,
    })
    .from(sourcesActive)
    .where(
      and(
        eq(sourcesActive.orgId, org.id),
        or(ne(sourcesActive.discovery, "on_demand"), sql`${sourcesActive.discovery} IS NULL`),
      ),
    )
    .orderBy(desc(sourcesActive.lastFetchedAt))
    .limit(5);

  return { org, sources: orgSources };
}
