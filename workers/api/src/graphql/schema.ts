import { and, count, desc, eq, inArray, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { computePagination } from "@buildinternet/releases-core/cli-contracts";
import { fromBase64Url, toBase64Url } from "@buildinternet/releases-core/cursor";
import { nowIso } from "@buildinternet/releases-core/dates";
import {
  domainAliases,
  organizations,
  organizationsActive,
  releasesVisible,
  sources,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
import { builder } from "./builder.js";
import "./types/org.js";
import "./types/product.js";
import "./types/source.js";
import "./types/release.js";
import "./types/media.js";
import "./types/stats.js";
import "./types/collection.js";
import { SourceTypeEnum } from "./types/enums.js";
import { getOrgIdsForList, countOrgsForList } from "../queries/orgs.js";
import { getCollectionsList, getCollectionBySlug } from "../queries/collections.js";
import type { CollectionMemberOrg, CollectionMemberProduct } from "./builder.js";

const isOrgId = (s: string) => s.startsWith("org_");
const isReleaseId = (s: string) => s.startsWith("rel_");

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const clampLimit = (n: number | null | undefined) =>
  Math.max(1, Math.min(n ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

// Cursor format mirrors REST's release feed (workers/api/src/routes/orgs.ts):
// `publishedAt|id`, base64url-wrapped so GraphQL clients treat it as opaque.
type ReleaseCursor = { publishedAt: string | null; id: string };

function encodeReleaseCursor(c: ReleaseCursor): string {
  return toBase64Url(`${c.publishedAt ?? ""}|${c.id}`);
}

function decodeReleaseCursor(token: string): ReleaseCursor | null {
  const raw = fromBase64Url(token);
  if (raw === null) return null;
  const pipeIdx = raw.indexOf("|");
  if (pipeIdx < 0) return null;
  const publishedAt = raw.slice(0, pipeIdx);
  const id = raw.slice(pipeIdx + 1);
  if (!id) return null;
  return { publishedAt: publishedAt || null, id };
}

builder.queryType({
  fields: (t) => ({
    org: t.field({
      type: "Org",
      nullable: true,
      description: "Look up an organization by id (org_…) or slug.",
      args: {
        idOrSlug: t.arg.string({ required: true }),
      },
      // Mirrors REST `GET /v1/orgs/:slug`: resolve by id/slug first, then fall
      // back to a domain-alias lookup so a domain-as-slug hit still resolves.
      resolve: async (_root, args, ctx) => {
        if (isOrgId(args.idOrSlug)) return ctx.loaders.orgById.load(args.idOrSlug);
        const bySlug = await ctx.loaders.orgBySlug.load(args.idOrSlug);
        if (bySlug) return bySlug;
        const [alias] = await ctx.db
          .select({ orgId: domainAliases.orgId })
          .from(domainAliases)
          .where(eq(domainAliases.domain, args.idOrSlug))
          .limit(1);
        return alias?.orgId ? ctx.loaders.orgById.load(alias.orgId) : null;
      },
    }),

    orgs: t.field({
      type: "OrgConnection",
      description:
        "Directory-shaped page of organizations, ordered by name. Hidden orgs are always " +
        "excluded; orgs with zero visible releases are excluded unless `includeEmpty` is set " +
        "(stub-tier orgs are kept regardless — same semantics as REST `GET /v1/orgs`).",
      args: {
        page: t.arg.int({ required: false, defaultValue: 1 }),
        limit: t.arg.int({ required: false, defaultValue: DEFAULT_PAGE_SIZE }),
        featured: t.arg.boolean({
          required: false,
          description: "Restrict to orgs editorially promoted for the home page.",
        }),
        includeEmpty: t.arg.boolean({
          required: false,
          defaultValue: false,
          description: "Include orgs with zero visible releases (stub-tier orgs are always kept).",
        }),
      },
      resolve: async (_root, args, ctx) => {
        const pageSize = clampLimit(args.limit);
        const page = Math.max(1, args.page ?? 1);
        const offset = (page - 1) * pageSize;
        const opts = {
          includeEmpty: args.includeEmpty ?? false,
          featured: args.featured ?? undefined,
        };
        const [ids, counts] = await Promise.all([
          getOrgIdsForList(ctx.db, { limit: pageSize, offset }, opts),
          countOrgsForList(ctx.db, undefined, opts),
        ]);
        // orgById is a dataloader — calling `.load` for every id inside one
        // Promise.all coalesces into a single batched query, and the
        // resolved array preserves the ids' (name-ordered) sequence.
        const items = (await Promise.all(ids.map((id) => ctx.loaders.orgById.load(id)))).filter(
          (o): o is NonNullable<typeof o> => o !== null,
        );
        return {
          items,
          pagination: computePagination({
            page,
            pageSize,
            returned: items.length,
            totalItems: counts.totalItems,
          }),
        };
      },
    }),

    stats: t.field({
      type: "Stats",
      description: "Flat registry rollup (orgs/sources/releases) — the homepage banner shape.",
      resolve: async (_root, _args, ctx) => {
        const [[orgCount], [sourceCount], [releaseCount]] = await Promise.all([
          ctx.db.select({ n: count() }).from(organizationsActive),
          ctx.db.select({ n: count() }).from(sourcesActive),
          ctx.db
            .select({ n: count() })
            .from(releasesVisible)
            .innerJoin(sourcesActive, eq(releasesVisible.sourceId, sourcesActive.id)),
        ]);
        return { orgs: orgCount.n, sources: sourceCount.n, releases: releaseCount.n };
      },
    }),

    collections: t.field({
      type: ["Collection"],
      description:
        "Curated collections with a member count and up to 3 preview members, ordered by name.",
      args: {
        featured: t.arg.boolean({
          required: false,
          description: "Restrict to homepage-featured collections.",
        }),
      },
      resolve: async (_root, args, ctx) => {
        const rows = await getCollectionsList(ctx.db, { featured: args.featured ?? false });
        return rows.map((r) => ({
          slug: r.slug,
          name: r.name,
          description: r.description,
          memberCount: r.memberCount,
          isFeatured: r.isFeatured,
          previewMembers: (r.previewMembers ?? []) as (
            | CollectionMemberOrg
            | CollectionMemberProduct
          )[],
        }));
      },
    }),

    collection: t.field({
      type: "Collection",
      nullable: true,
      description:
        "Look up a collection by slug for the collection detail page (members + feed + " +
        "daily summaries via nested fields). #2047",
      args: {
        slug: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const row = await getCollectionBySlug(ctx.db, args.slug);
        if (!row) return null;
        // Detail path: id + dailySummaryEnabled present; memberCount unused by chrome.
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          memberCount: 0,
          isFeatured: row.isFeatured,
          dailySummaryEnabled: row.dailySummaryEnabled,
          previewMembers: [],
        };
      },
    }),

    source: t.field({
      type: "Source",
      nullable: true,
      description: "Look up a source by id (src_…). Slug-only lookups require an org context.",
      args: {
        id: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) => ctx.loaders.sourceById.load(args.id),
    }),

    product: t.field({
      type: "Product",
      nullable: true,
      description: "Look up a product by id. Slug-only lookups require an org context.",
      args: {
        id: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) => ctx.loaders.productById.load(args.id),
    }),

    release: t.field({
      type: "Release",
      nullable: true,
      description: "Look up a release by id (rel_…) — or by url for legacy callers.",
      args: {
        idOrUrl: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        if (isReleaseId(args.idOrUrl)) {
          return ctx.loaders.releaseById.load(args.idOrUrl);
        }
        const [row] = await ctx.db
          .select()
          .from(releasesVisible)
          .where(eq(releasesVisible.url, args.idOrUrl))
          .limit(1);
        return row ?? null;
      },
    }),

    latestReleases: t.field({
      type: "ReleaseFeed",
      description:
        "Feed-shaped slice of recent visible releases. Pass `cursor` from the previous page's `nextCursor` to fetch the next slice. " +
        "Optional `orgIdOrSlug` and/or `productId` narrow the feed (product page SSR uses productId).",
      args: {
        limit: t.arg.int({ required: false, defaultValue: DEFAULT_PAGE_SIZE }),
        cursor: t.arg.string({ required: false }),
        orgIdOrSlug: t.arg.string({ required: false }),
        productId: t.arg.string({
          required: false,
          description:
            "Restrict to sources under this product (prod_…). Same semantics as REST " +
            "`GET /v1/orgs/:slug/releases?product=` for the product-page critical path.",
        }),
        excludeSourceTypes: t.arg({
          type: [SourceTypeEnum],
          required: false,
          description: "Drop releases whose source.type is in this list.",
        }),
      },
      resolve: async (_root, args, ctx) => {
        const pageSize = clampLimit(args.limit);

        const excludeFilter =
          args.excludeSourceTypes && args.excludeSourceTypes.length > 0
            ? not(inArray(sources.type, args.excludeSourceTypes))
            : undefined;

        // Content-quality tier (`metadata.contentQuality`): a per-source signal
        // — `low | normal | high`, default `normal` (absent) — that lets us
        // de-prioritize noisy sources and, later, boost high-signal ones rather
        // than a binary hide. Today only `low` has an effect: it drops the
        // source from this feed, which backs only the homepage "Shipping now"
        // ticker. So a `low` source stays fully present in search, the catalog,
        // its source page, related rails, and the REST `/v1/releases` feed
        // (unlike the heavier `sources.isHidden`) — it just stops occupying its
        // org's homepage ticker slot, letting the org's higher-signal sources
        // own it. `high` is reserved for a future ranking boost and is a no-op
        // here. SQLite `json_extract` returns the JSON string; `IS NOT 'low'`
        // keeps rows where the key is absent (NULL), `normal`, or `high`.
        //
        // Skip when the feed is scoped to a product (or org) — those surfaces
        // mirror REST org/product release lists, which do not apply the
        // ticker-only quality filter (#2047 product page).
        const qualityFilter =
          args.productId || args.orgIdOrSlug
            ? undefined
            : sql`(json_extract(${sources.metadata}, '$.contentQuality') IS NOT 'low')`;

        // Drop releases whose upstream-supplied date is in the future. Sources
        // occasionally publish a misdated entry (typo, scheduled-post slip);
        // without this, the row sticks at the top of the feed until the date
        // arrives. NULL publishedAt is preserved — those legitimately sort
        // last and are reachable via the cursor walk.
        const cutoff = nowIso();
        const futureFilter = or(
          lte(releasesVisible.publishedAt, cutoff),
          isNull(releasesVisible.publishedAt),
        );

        let orgFilter = undefined;
        if (args.orgIdOrSlug) {
          const org = isOrgId(args.orgIdOrSlug)
            ? await ctx.loaders.orgById.load(args.orgIdOrSlug)
            : await ctx.loaders.orgBySlug.load(args.orgIdOrSlug);
          if (!org) return { items: [], nextCursor: null };
          orgFilter = eq(sources.orgId, org.id);
        }

        // Product filter is AND-able with org (a product is always under one
        // org). Unknown productId → empty feed, not an error — matches the
        // null-product REST path and keeps SSR fail-soft.
        const productFilter = args.productId ? eq(sources.productId, args.productId) : undefined;

        // Cursor predicate: strict-less-than on (publishedAt, id) so the next
        // page starts after the last row from the previous page. Releases
        // without publishedAt sort last and tiebreak by id.
        let cursorFilter = undefined;
        if (args.cursor) {
          const c = decodeReleaseCursor(args.cursor);
          if (!c) {
            // Opaque cursors only legitimately come from the API itself, so
            // a decode miss is a tampered/truncated token, not "end of feed".
            throw new GraphQLError("Invalid cursor", {
              extensions: { code: "BAD_USER_INPUT" },
            });
          }
          // SQLite default sorts NULL last in DESC order, so once the cursor
          // moves past dated rows the next page must also include rows where
          // publishedAt IS NULL — `lt(NULL, …)` is NULL, not true, so an
          // explicit branch is needed to make those rows reachable.
          cursorFilter = c.publishedAt
            ? or(
                lt(releasesVisible.publishedAt, c.publishedAt),
                and(eq(releasesVisible.publishedAt, c.publishedAt), lt(releasesVisible.id, c.id)),
                isNull(releasesVisible.publishedAt),
              )
            : and(isNull(releasesVisible.publishedAt), lt(releasesVisible.id, c.id));
        }

        // limit+1 trick: fetch one extra row to detect "is there a next page?"
        // without a separate count query.
        const rows = await ctx.db
          .select()
          .from(releasesVisible)
          .innerJoin(sources, eq(sources.id, releasesVisible.sourceId))
          // Join the org so hidden orgs ("don't feature") drop off this feed —
          // it backs the homepage ticker. sources.orgId is NOT NULL, so the
          // inner join can't shed otherwise-visible rows. Mirrors the
          // is_hidden filter on the REST getLatestReleasesAcross path.
          .innerJoin(organizations, eq(organizations.id, sources.orgId))
          .where(
            and(
              eq(sources.isHidden, false),
              isNull(sources.deletedAt),
              eq(organizations.isHidden, false),
              // Drop soft-deleted orgs. A tombstoned org keeps its row (slug
              // mangled to "<slug>--<id>") and can outlive the tombstoning of
              // its sources, so the source-side `isNull(sources.deletedAt)`
              // above isn't enough — guard the org side too. Mirrors the
              // `o.deleted_at IS NULL` clause on the REST path.
              isNull(organizations.deletedAt),
              orgFilter,
              productFilter,
              excludeFilter,
              qualityFilter,
              futureFilter,
              cursorFilter,
            ),
          )
          .orderBy(desc(releasesVisible.publishedAt), desc(releasesVisible.id))
          .limit(pageSize + 1);

        const hasMore = rows.length > pageSize;
        const page = (hasMore ? rows.slice(0, pageSize) : rows).map((r) => r.releases_visible);
        const last = page[page.length - 1];
        const nextCursor =
          hasMore && last
            ? encodeReleaseCursor({ publishedAt: last.publishedAt, id: last.id })
            : null;
        return { items: page, nextCursor };
      },
    }),
  }),
});

export const schema = builder.toSchema();
