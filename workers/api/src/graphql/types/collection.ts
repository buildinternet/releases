import { builder, type CollectionRelease } from "../builder.js";
import { addDaysToDateKey, etDayKey } from "@buildinternet/releases-core/dates";
import { getCollectionBySlug, getCollectionFullMembers } from "../../queries/collections.js";
import {
  getCollectionMembers,
  listCollectionDailySummaries,
} from "../../queries/collection-summaries.js";
import { getCollectionReleasesFeed } from "../../queries/orgs.js";
import { buildFeedCursor, formatAggregateReleaseRow } from "../../utils.js";

const CollectionMemberOrgType = builder.objectType("CollectionMemberOrg", {
  description: "An org as it appears in a collection's member preview.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    domain: t.exposeString("domain", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    githubHandle: t.exposeString("githubHandle", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
  }),
});

const CollectionMemberProductOrgType = builder.objectType("CollectionMemberProductOrg", {
  description:
    "Parent-org context on a product member, so the chip can render the org's avatar. " +
    "Subset of CollectionMemberOrg — no `description`, matching REST's ProductParentOrg.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    domain: t.exposeString("domain", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    githubHandle: t.exposeString("githubHandle", { nullable: true }),
  }),
});

const CollectionMemberProductType = builder.objectType("CollectionMemberProduct", {
  description: "A product as it appears in a collection's member preview.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    org: t.field({ type: CollectionMemberProductOrgType, resolve: (p) => p.org }),
  }),
});

/** Mixed-kind member entry — discriminate on `__typename` client-side
 *  (`... on CollectionMemberOrg` / `... on CollectionMemberProduct`). */
export const CollectionMemberUnion = builder.unionType("CollectionMember", {
  description: "One entry in a collection's `previewMembers` — either an org or a product.",
  types: [CollectionMemberOrgType, CollectionMemberProductType],
  resolveType: (m) => (m.kind === "org" ? CollectionMemberOrgType : CollectionMemberProductType),
});

/** Slim org identity on a collection-feed release (matches REST CollectionReleaseItem.org). */
const CollectionReleaseOrgType = builder.objectType("CollectionReleaseOrg", {
  description: "Parent org on a cross-member collection release row.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
  }),
});

/** Slim source identity on a collection-feed release. */
const CollectionReleaseSourceType = builder.objectType("CollectionReleaseSource", {
  description: "Source on a cross-member collection release row.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    type: t.exposeString("type"),
  }),
});

/** Slim product identity on a collection-feed release. */
const CollectionReleaseProductType = builder.objectType("CollectionReleaseProduct", {
  description:
    "Product on a cross-member collection release row, when the source is product-bound.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
  }),
});

/**
 * One row of a collection's interleaved release feed. Mirrors REST
 * `CollectionReleaseItem` so the web CollectionTimeline can consume GraphQL
 * SSR output without a second shape. Distinct from the catalog `Release` type
 * (which nests via Source loaders) because the feed query already projects
 * org/source/product denormalized.
 */
export const CollectionReleaseType = builder.objectType("CollectionRelease", {
  description:
    "A release row in a collection's cross-member feed (REST CollectionReleaseItem shape).",
  fields: (t) => ({
    id: t.exposeID("id"),
    title: t.exposeString("title"),
    version: t.exposeString("version", { nullable: true }),
    type: t.exposeString("type"),
    url: t.exposeString("url", { nullable: true }),
    publishedAt: t.expose("publishedAt", { type: "DateTime", nullable: true }),
    summary: t.exposeString("summary"),
    content: t.exposeString("content"),
    titleGenerated: t.exposeString("titleGenerated", { nullable: true }),
    titleShort: t.exposeString("titleShort", { nullable: true }),
    prerelease: t.exposeBoolean("prerelease"),
    media: t.field({
      type: ["Media"],
      resolve: (r) => r.media,
    }),
    source: t.field({
      type: CollectionReleaseSourceType,
      resolve: (r) => r.source,
    }),
    org: t.field({
      type: CollectionReleaseOrgType,
      resolve: (r) => r.org,
    }),
    product: t.field({
      type: CollectionReleaseProductType,
      nullable: true,
      resolve: (r) => r.product,
    }),
    groupSlug: t.exposeString("groupSlug"),
    groupName: t.exposeString("groupName"),
    coverageCount: t.exposeInt("coverageCount"),
    composition: t.field({
      type: "ReleaseComposition",
      nullable: true,
      resolve: (r) => r.composition,
    }),
  }),
});

export const CollectionReleaseFeedType = builder.objectType("CollectionReleaseFeed", {
  description: "Cursor-paginated collection release feed (SSR first page + load-more cursor).",
  fields: (t) => ({
    items: t.field({
      type: [CollectionReleaseType],
      resolve: (f) => f.items,
    }),
    nextCursor: t.exposeString("nextCursor", { nullable: true }),
  }),
});

export const CollectionDailySummaryType = builder.objectType("CollectionDailySummary", {
  description: "AI-generated daily rollup for one ET calendar day in a collection.",
  fields: (t) => ({
    date: t.exposeString("date"),
    title: t.exposeString("title"),
    summary: t.exposeString("summary"),
    takeaways: t.exposeStringList("takeaways"),
    releaseCount: t.exposeInt("releaseCount"),
  }),
});

const MAX_RELEASE_LIMIT = 50;
const DEFAULT_RELEASE_LIMIT = 20;

/** Map REST wire row → GraphQL parent with required fields filled. */
function toCollectionRelease(row: ReturnType<typeof formatAggregateReleaseRow>): CollectionRelease {
  return {
    id: row.id ?? "",
    title: row.title,
    version: row.version,
    type: row.type ?? "feature",
    url: row.url,
    publishedAt: row.publishedAt,
    summary: row.summary,
    content: row.content ?? "",
    titleGenerated: row.titleGenerated ?? null,
    titleShort: row.titleShort ?? null,
    prerelease: row.prerelease ?? false,
    media: row.media ?? [],
    source: row.source,
    org: row.org,
    product: row.product ?? null,
    groupSlug: row.groupSlug ?? row.product?.slug ?? row.source.slug,
    groupName: row.groupName ?? row.product?.name ?? row.source.name,
    coverageCount: row.coverageCount ?? 0,
    composition: row.composition ?? null,
  };
}

export const CollectionType = builder.objectType("Collection", {
  description: "A curated, named group of orgs/products (independent of the `category` taxonomy).",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    memberCount: t.exposeInt("memberCount"),
    isFeatured: t.exposeBoolean("isFeatured"),
    dailySummaryEnabled: t.field({
      type: "Boolean",
      description:
        "Whether the nightly collection-summaries cron is enabled for this collection. " +
        "Defaults false when the parent object was loaded as a list preview without the column.",
      resolve: async (c, _args, ctx) => {
        if (typeof c.dailySummaryEnabled === "boolean") return c.dailySummaryEnabled;
        const row = await getCollectionBySlug(ctx.db, c.slug);
        return row?.dailySummaryEnabled ?? false;
      },
    }),
    previewMembers: t.field({
      type: [CollectionMemberUnion],
      description: "Up to 3 interleaved org/product members, for inline avatar chips.",
      resolve: (c) => c.previewMembers,
    }),
    members: t.field({
      type: [CollectionMemberUnion],
      description:
        "Full ordered membership for the collection detail page. Mirrors REST " +
        "`GET /v1/collections/:slug` members.",
      resolve: async (c, _args, ctx) => {
        const id = c.id ?? (await getCollectionBySlug(ctx.db, c.slug))?.id;
        if (!id) return [];
        return getCollectionFullMembers(ctx.db, id);
      },
    }),
    releases: t.field({
      type: CollectionReleaseFeedType,
      description:
        "Interleaved cross-member release feed (newest first). SSR first page only — " +
        "client load-more stays on REST. Cursor shape matches REST " +
        "`publishedAt|fetchedAt|id`.",
      args: {
        limit: t.arg.int({ required: false, defaultValue: DEFAULT_RELEASE_LIMIT }),
      },
      resolve: async (c, args, ctx) => {
        const id = c.id ?? (await getCollectionBySlug(ctx.db, c.slug))?.id;
        if (!id) return { items: [] as CollectionRelease[], nextCursor: null };
        const pageSize = Math.max(
          1,
          Math.min(args.limit ?? DEFAULT_RELEASE_LIMIT, MAX_RELEASE_LIMIT),
        );
        const { orgIds, productIds } = await getCollectionMembers(ctx.db, id);
        const rows = await getCollectionReleasesFeed(ctx.db, orgIds, null, pageSize + 1, {
          productIds,
        });
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        const items = pageRows.map((r) =>
          toCollectionRelease(formatAggregateReleaseRow(r, ctx.mediaOrigin)),
        );
        const last = pageRows[pageRows.length - 1];
        const nextCursor = hasMore && last ? buildFeedCursor(last) : null;
        return { items, nextCursor };
      },
    }),
    dailySummaries: t.field({
      type: [CollectionDailySummaryType],
      description:
        "AI daily summaries for the last 30 ET days (newest first). Fail-soft empty " +
        "when none exist — same default window as REST " +
        "`GET /v1/collections/:slug/daily-summaries`.",
      resolve: async (c, _args, ctx) => {
        const id = c.id ?? (await getCollectionBySlug(ctx.db, c.slug))?.id;
        if (!id) return [];
        const now = new Date();
        const to = etDayKey(now);
        const from = addDaysToDateKey(to, -30);
        return listCollectionDailySummaries(ctx.db, id, from, to);
      },
    }),
  }),
});
