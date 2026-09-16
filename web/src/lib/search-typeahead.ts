import type {
  SearchCatalogHit,
  SearchCollectionHit,
  SearchOrgHit,
  SearchReleaseHit,
  UnifiedSearchResponse,
} from "./api";
import { productPath, sourcePath } from "./links";

/**
 * Header (launcher) search: typing never navigates. The previous implementation
 * routed to `/search` on the first keystroke, which remounted a second input
 * mid-composition and left the header box and the page box out of sync.
 */
export type LauncherAction =
  | { type: "change"; query: string }
  | { type: "submit"; query: string; highlight: number | null; items: TypeaheadItem[] }
  | { type: "select"; item: TypeaheadItem };

export type LauncherResult = { kind: "compose"; query: string } | { kind: "go"; href: string };

export type TypeaheadKind = "search" | "org" | "product" | "collection" | "release";

export type TypeaheadItem = {
  id: string;
  href: string;
  label: string;
  secondary?: string;
  kind: TypeaheadKind;
};

/** Caps keep the dropdown short — the search page is the full result set. */
export const TYPEAHEAD_CAPS = {
  orgs: 3,
  products: 3,
  collections: 2,
  releases: 3,
} as const;

export function searchPageHref(query: string): string {
  const trimmed = query.trim();
  return trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
}

export function launcherAction(action: LauncherAction): LauncherResult {
  if (action.type === "change") {
    return { kind: "compose", query: action.query };
  }
  if (action.type === "select") {
    return { kind: "go", href: action.item.href };
  }
  const hit = action.highlight != null ? action.items[action.highlight] : undefined;
  return { kind: "go", href: hit?.href ?? searchPageHref(action.query) };
}

/**
 * Arrow through the list; stepping off either end clears the highlight so
 * Enter falls back to the full search page (type + Enter, no arrow).
 */
export function moveHighlight(current: number | null, dir: 1 | -1, count: number): number | null {
  if (count === 0) return null;
  if (current == null) return dir === 1 ? 0 : count - 1;
  const next = current + dir;
  if (next < 0 || next >= count) return null;
  return next;
}

/**
 * Drop hits that belong to a previous query (e.g. leftover "api" rows after
 * the box now says "meet"). Prefix matches stay so in-flight "me" results
 * can still preview while the user finishes "meet".
 */
export function resultsMatchQuery(results: UnifiedSearchResponse | null, query: string): boolean {
  if (!results) return false;
  const q = query.trim().toLowerCase();
  const rq = results.query.trim().toLowerCase();
  if (!q || !rq) return false;
  return q === rq || q.startsWith(rq);
}

export function typeaheadItems(
  results: UnifiedSearchResponse | null,
  query: string,
): TypeaheadItem[] {
  const trimmed = query.trim();
  const items: TypeaheadItem[] = [];
  if (trimmed) {
    items.push({
      id: "search-all",
      href: searchPageHref(trimmed),
      label: `Search all results for “${trimmed}”`,
      kind: "search",
    });
  }
  if (!results) return items;

  for (const org of results.orgs.slice(0, TYPEAHEAD_CAPS.orgs)) {
    items.push(orgItem(org));
  }
  for (const product of results.catalog.slice(0, TYPEAHEAD_CAPS.products)) {
    items.push(catalogItem(product));
  }
  for (const collection of (results.collections ?? []).slice(0, TYPEAHEAD_CAPS.collections)) {
    items.push(collectionItem(collection));
  }
  for (const release of results.releases.slice(0, TYPEAHEAD_CAPS.releases)) {
    items.push(releaseItem(release));
  }
  return items;
}

function orgItem(org: SearchOrgHit): TypeaheadItem {
  return {
    id: `org:${org.slug}`,
    href: `/${org.slug}`,
    label: org.name,
    secondary: org.domain ?? undefined,
    kind: "org",
  };
}

function catalogItem(hit: SearchCatalogHit): TypeaheadItem {
  const href =
    hit.entryType === "source" && hit.sourceSlug
      ? sourcePath(hit.orgSlug, hit.sourceSlug)
      : productPath(hit.orgSlug, hit.slug);
  return {
    id: `${hit.entryType}:${hit.orgSlug ?? "_"}:${hit.slug}`,
    href,
    label: hit.name,
    secondary: hit.orgName ?? undefined,
    kind: "product",
  };
}

function collectionItem(hit: SearchCollectionHit): TypeaheadItem {
  return {
    id: `collection:${hit.slug}`,
    href: `/collections/${hit.slug}`,
    label: hit.name,
    secondary: hit.memberCount === 1 ? "1 member" : `${hit.memberCount} members`,
    kind: "collection",
  };
}

function releaseItem(hit: SearchReleaseHit): TypeaheadItem {
  return {
    id: `release:${hit.id}`,
    href: `/release/${hit.id}`,
    label: hit.version || hit.titleShort || hit.title,
    secondary: hit.sourceName,
    kind: "release",
  };
}
