// Reusable SQL fragments live in the shared read layer (packages/queries) so
// the MCP worker builds the same subqueries. Re-exported for existing callers.
export { nullsLastOrderBy, githubHandleSubquery } from "@releases/queries/sql-fragments";

/** Common row type for source list items with release stats */
export type SourceWithStats = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  is_primary: number | null;
  is_hidden: number | null;
  discovery: "curated" | "agent" | "on_demand" | null;
  fetch_priority: string | null;
  last_fetched_at: string | null;
  last_polled_at: string | null;
  release_count: number;
  latest_version_by_date: string | null;
  latest_date: string | null;
  latest_version_by_fetch: string | null;
  latest_added_at: string | null;
  product_slug: string | null;
  product_name: string | null;
  kind: string | null;
  metadata: string | null;
};

/** Common row type for org list items */
export type OrgListRow = {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  avatar_url: string | null;
  featured: number;
  tier: "stub" | "tracked";
  source_count: number;
  release_count: number;
  last_activity: string | null;
  recent_release_count: number;
  top_products: string | null;
  alias_domains: string | null;
};
