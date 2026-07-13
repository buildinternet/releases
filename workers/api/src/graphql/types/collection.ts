import { builder, type CollectionRelease } from "../builder.js";
import { addDaysToDateKey, etDayKey } from "@buildinternet/releases-core/dates";
import { getCollectionBySlug, getCollectionFullMembers } from "../../queries/collections.js";
import {
  getCollectionMembers,
  listCollectionDailySummaries,
} from "../../queries/collection-summaries.js";
import { getCollectionReleasesFeed } from "../../queries/orgs.js";
import { buildFeedCursor, formatAggregateReleaseRow } from "../../utils.js";
import type { D1Db } from "../../db.js";

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
    "Parent-org context on a product member (avatar chip). Subset of CollectionMemberOrg — " +
    "no `description`, matching REST ProductParentOrg.",
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
    org: t.expose("org", { type: CollectionMemberProductOrgType }),
  }),
});

/** Discriminate on `__typename` (`CollectionMemberOrg` / `CollectionMemberProduct`). */
export const CollectionMemberUnion = builder.unionType("CollectionMember", {
  description: "One entry in a collection's `previewMembers` — either an org or a product.",
  types: [CollectionMemberOrgType, CollectionMemberProductType],
  resolveType: (m) => (m.kind === "org" ? CollectionMemberOrgType : CollectionMemberProductType),
});

const CollectionReleaseOrgType = builder.objectType("CollectionReleaseOrg", {
  description: "Parent org on a cross-member collection release row.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
  }),
});

const CollectionReleaseSourceType = builder.objectType("CollectionReleaseSource", {
  description: "Source on a cross-member collection release row.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    type: t.exposeString("type"),
  }),
});

const CollectionReleaseProductType = builder.objectType("CollectionReleaseProduct", {
  description: "Product on a collection-feed release when the source is product-bound.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
  }),
});

/**
 * Collection feed row — REST CollectionReleaseItem shape for SSR without a
 * second map. Distinct from catalog `Release` (which nests via Source loaders)
 * because the feed query already projects org/source/product denormalized.
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
    importance: t.exposeInt("importance", {
      nullable: true,
      description:
        "AI-scored release importance, 1 (housekeeping) to 5 (landmark). Null when unscored.",
    }),
    prerelease: t.exposeBoolean("prerelease"),
    media: t.expose("media", { type: ["Media"] }),
    source: t.expose("source", { type: CollectionReleaseSourceType }),
    org: t.expose("org", { type: CollectionReleaseOrgType }),
    product: t.expose("product", { type: CollectionReleaseProductType, nullable: true }),
    groupSlug: t.exposeString("groupSlug"),
    groupName: t.exposeString("groupName"),
    coverageCount: t.exposeInt("coverageCount"),
    composition: t.expose("composition", { type: "ReleaseComposition", nullable: true }),
  }),
});

export const CollectionReleaseFeedType = builder.objectType("CollectionReleaseFeed", {
  description: "Cursor-paginated collection release feed (SSR first page + load-more cursor).",
  fields: (t) => ({
    items: t.expose("items", { type: [CollectionReleaseType] }),
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

/** Prefer parent `id` when present; fall back to slug lookup (list previews). */
async function resolveCollectionId(
  db: D1Db,
  c: { id?: string; slug: string },
): Promise<string | null> {
  if (c.id) return c.id;
  return (await getCollectionBySlug(db, c.slug))?.id ?? null;
}

/**
 * REST wire row → GraphQL parent. `formatAggregateReleaseRow` always fills
 * these; defaults only satisfy optional REST mid-deploy fields.
 */
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
    importance: row.importance ?? null,
    prerelease: row.prerelease ?? false,
    media: row.media ?? [],
    source: row.source,
    org: row.org,
    product: row.product ?? null,
    groupSlug: row.groupSlug ?? row.source.slug,
    groupName: row.groupName ?? row.source.name,
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
        "Whether the nightly collection-summaries cron is enabled. Defaults false when the " +
        "parent was loaded as a list preview without the column.",
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
        const id = await resolveCollectionId(ctx.db, c);
        if (!id) return [];
        return getCollectionFullMembers(ctx.db, id);
      },
    }),
    releases: t.field({
      type: CollectionReleaseFeedType,
      description:
        "Interleaved cross-member release feed (newest first). SSR first page only — " +
        "client load-more stays on REST. Cursor shape matches REST `publishedAt|fetchedAt|id`.",
      args: {
        limit: t.arg.int({ required: false, defaultValue: DEFAULT_RELEASE_LIMIT }),
      },
      resolve: async (c, args, ctx) => {
        const id = await resolveCollectionId(ctx.db, c);
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
        "AI daily summaries for the last 30 ET days (newest first). Fail-soft empty when " +
        "none exist — same default window as REST `GET /v1/collections/:slug/daily-summaries`.",
      resolve: async (c, _args, ctx) => {
        const id = await resolveCollectionId(ctx.db, c);
        if (!id) return [];
        const to = etDayKey(new Date());
        return listCollectionDailySummaries(ctx.db, id, addDaysToDateKey(to, -30), to);
      },
    }),
  }),
});
