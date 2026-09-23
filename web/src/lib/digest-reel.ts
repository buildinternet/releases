import type { HomepageDigestsQuery } from "@/lib/graphql/__generated__/graphql";

export type ReelDigest = HomepageDigestsQuery["latestWeeklyDigests"][number];
type ReelSection = ReelDigest["sections"][number];
type ReelOrg = ReelSection["releases"][number]["org"];
type ReelSectionRelease = ReelSection["releases"][number];

/** Section rows shown per card; the rest live on the digest page. */
export const CARD_SECTIONS = 3;
/** Releases listed in a section's hover card before the "+N more" count. */
export const HOVER_RELEASES = 3;

/** Order the homepage reel — featured collections first, then the busiest
 *  weeks, then by name — and split it into the cards the reel shows and the
 *  overflow listed under "Also this week". */
export function splitDigestReel(digests: ReelDigest[], cardCount = 6) {
  const sorted = [...digests].sort(
    (a, b) =>
      Number(b.collection.isFeatured) - Number(a.collection.isFeatured) ||
      b.releaseCount - a.releaseCount ||
      a.collection.name.localeCompare(b.collection.name),
  );
  return { cards: sorted.slice(0, cardCount), more: sorted.slice(cardCount) };
}

/** One distinct product a section covers, with its org for the avatar. */
export interface SectionProduct<TOrg> {
  key: string;
  name: string;
  org: TOrg;
}

/** Distinct products a section covers (by product slug, falling back to the
 *  org for product-less releases), labelled with the product name when there
 *  is one. First-seen order. Takes any section with hydrated `releases` —
 *  the GraphQL reel's and the REST digest detail's alike. */
export function sectionProducts<TOrg extends { slug: string; name: string }>(section: {
  releases: readonly { product?: { slug: string; name: string } | null; org: TOrg }[];
}): SectionProduct<TOrg>[] {
  const out = new Map<string, SectionProduct<TOrg>>();
  for (const r of section.releases) {
    const key = r.product?.slug ?? `org:${r.org.slug}`;
    if (!out.has(key)) out.set(key, { key, name: r.product?.name ?? r.org.name, org: r.org });
  }
  return [...out.values()];
}

/** Internal link to a digest issue, optionally deep-linked to a section. */
export function digestHref(
  d: { collection: { slug: string }; weekStart: string },
  anchor?: string,
) {
  return `/collections/${d.collection.slug}/digest/${d.weekStart}${anchor ? `#${anchor}` : ""}`;
}

// ── Homepage reel preview (server-trimmed payload) ──────────────────────
//
// `latestWeeklyDigests` (a `ReelDigest[]`) carries every collection's full
// digest — every section, every cited release. `DigestReel` only ever
// renders `splitDigestReel`'s first `cardCount` cards, `CARD_SECTIONS`
// sections per card, and `HOVER_RELEASES` releases per section's hover card
// — so `toReelPreview` does that trimming once, server-side, instead of
// shipping the full payload to the client for the component to slice on
// every render.

/** One product chip in a card section's row/hover-card — the full deduped
 *  list (uncapped), so the client's "+N" count (past `HOVER_PRODUCTS`) stays
 *  right. */
export type ReelCardProduct = SectionProduct<ReelOrg>;

export interface ReelCardSection {
  heading: string;
  anchor: string;
  lede: string;
  /** Full deduped product list — see {@link ReelCardProduct}. */
  products: ReelCardProduct[];
  /** Total releases the section cites, independent of how many are below —
   *  drives the "N releases · +M more" text. */
  releaseCount: number;
  /** Sliced to {@link HOVER_RELEASES}. */
  releases: ReelSectionRelease[];
}

export interface ReelCard {
  collection: { slug: string; name: string };
  weekStart: string;
  title: string;
  intro: string;
  /** Total releases the digest covers — the footer's release count. */
  releaseCount: number;
  /** Total distinct orgs the digest covers — the footer's org count,
   *  independent of how many avatars render (`orgs` below is capped). */
  orgCount: number;
  /** Sliced to 3 for the avatar stack. */
  orgs: ReelOrg[];
  /** Sliced to {@link CARD_SECTIONS}. */
  sections: ReelCardSection[];
}

export interface ReelMoreItem {
  collection: { slug: string; name: string };
  weekStart: string;
}

export interface ReelPreview {
  /** All digests this week, before the reel/overflow split — drives the
   *  header's "N collections" count. */
  totalCount: number;
  cards: ReelCard[];
  more: ReelMoreItem[];
}

/** Pure, server-safe trim: `splitDigestReel` plus the compact shape
 *  {@link DigestReel} and its section preview actually render. Every
 *  rendered string/number in the compact shape matches what the full
 *  `ReelDigest[]` would have produced. */
export function toReelPreview(digests: ReelDigest[]): ReelPreview {
  const { cards, more } = splitDigestReel(digests);
  return {
    totalCount: digests.length,
    cards: cards.map((d): ReelCard => ({
      collection: { slug: d.collection.slug, name: d.collection.name },
      weekStart: d.weekStart,
      title: d.title,
      intro: d.intro,
      releaseCount: d.releaseCount,
      orgCount: d.orgs.length,
      orgs: d.orgs.slice(0, 3),
      sections: d.sections.slice(0, CARD_SECTIONS).map((s): ReelCardSection => ({
        heading: s.heading,
        anchor: s.anchor,
        lede: s.lede,
        products: sectionProducts(s),
        releaseCount: s.releases.length,
        releases: s.releases.slice(0, HOVER_RELEASES),
      })),
    })),
    more: more.map((d) => ({
      collection: { slug: d.collection.slug, name: d.collection.name },
      weekStart: d.weekStart,
    })),
  };
}
