/**
 * Domain → owner resolution. Backs REST `GET /v1/lookups/by-domain`, the
 * `?domain=` filter on `/v1/search`, the org-create domain collision check,
 * and the MCP `lookup_domain` tool. Callers normalize the domain first
 * (`normalizeDomain` from `@buildinternet/releases-core/domain`).
 *
 * Soft-deleted orgs and products never match (`*_active` views).
 */
import { asc, eq, or, sql } from "drizzle-orm";
import {
  domainAliases,
  organizationsActive,
  productsActive,
} from "@buildinternet/releases-core/schema";
import type { AnyDb } from "@releases/lib/db";

export interface OrgByDomainRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  avatarUrl: string | null;
  tier: "stub" | "tracked";
  matchedVia: "primary" | "alias";
}

export interface ProductByDomainRow {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  category: string | null;
}

/**
 * Resolve a (pre-normalized) domain to its owning org. Single LEFT JOIN
 * against `domain_aliases` handles both primary and alias matches in one
 * round-trip; both columns are uniquely indexed so a single hit is
 * dispositive. Oldest org wins on the (theoretical) tie. Returns `null` when
 * no row matches.
 */
export async function findOrgByDomain(db: AnyDb, domain: string): Promise<OrgByDomainRow | null> {
  const [row] = await db
    .select({
      id: organizationsActive.id,
      slug: organizationsActive.slug,
      name: organizationsActive.name,
      domain: organizationsActive.domain,
      description: organizationsActive.description,
      category: organizationsActive.category,
      avatarUrl: organizationsActive.avatarUrl,
      tier: organizationsActive.tier,
      matchedVia: sql<
        "primary" | "alias"
      >`CASE WHEN ${organizationsActive.domain} = ${domain} THEN 'primary' ELSE 'alias' END`,
    })
    .from(organizationsActive)
    .leftJoin(domainAliases, eq(domainAliases.orgId, organizationsActive.id))
    .where(or(eq(organizationsActive.domain, domain), eq(domainAliases.domain, domain)))
    .orderBy(asc(organizationsActive.createdAt), asc(organizationsActive.id))
    .limit(1);
  return (row as OrgByDomainRow | undefined) ?? null;
}

/**
 * Products whose domain alias is exactly `domain` (a product can own a
 * subdomain its parent org does not), with the parent org's slug and name.
 * Ordered by product name, then id.
 */
export async function findProductsByDomain(
  db: AnyDb,
  domain: string,
): Promise<ProductByDomainRow[]> {
  return db
    .select({
      id: productsActive.id,
      slug: productsActive.slug,
      name: productsActive.name,
      orgId: productsActive.orgId,
      orgSlug: organizationsActive.slug,
      orgName: organizationsActive.name,
      category: productsActive.category,
    })
    .from(productsActive)
    .innerJoin(domainAliases, eq(domainAliases.productId, productsActive.id))
    .innerJoin(organizationsActive, eq(organizationsActive.id, productsActive.orgId))
    .where(eq(domainAliases.domain, domain))
    .orderBy(asc(productsActive.name), asc(productsActive.id));
}
