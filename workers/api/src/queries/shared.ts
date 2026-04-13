import { sql } from "drizzle-orm";
import { sources, releases } from "@releases/db/schema.js";

/** Exclude hidden sources: (is_hidden = 0 OR is_hidden IS NULL) */
export const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;

/** Exclude suppressed releases — for use in Drizzle WHERE clauses */
export const notSuppressed = sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`;

/** Common row type for source list items with release stats */
export type SourceWithStats = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  is_primary: number | null;
  is_hidden: number | null;
  fetch_priority: string | null;
  release_count: number;
  latest_version_by_date: string | null;
  latest_date: string | null;
  latest_version_by_fetch: string | null;
  latest_added_at: string | null;
  product_slug: string | null;
  product_name: string | null;
};

/** Common row type for org list items */
export type OrgListRow = {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  source_count: number;
  release_count: number;
  last_activity: string | null;
  recent_release_count: number;
  top_products: string | null;
};
