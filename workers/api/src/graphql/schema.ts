import { and, desc, eq, inArray, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { computePagination } from "@buildinternet/releases-core/cli-contracts";
import { fromBase64Url, toBase64Url } from "@buildinternet/releases-core/cursor";
import { nowIso } from "@buildinternet/releases-core/dates";
import { organizations, releasesVisible, sources } from "@buildinternet/releases-core/schema";
import { builder } from "./builder.js";
import "./types/org.js";
import "./types/product.js";
import "./types/source.js";
import "./types/release.js";
import "./types/media.js";
import { SourceTypeEnum } from "./types/enums.js";

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
      resolve: (_root, args, ctx) =>
        isOrgId(args.idOrSlug)
          ? ctx.loaders.orgById.load(args.idOrSlug)
          : ctx.loaders.orgBySlug.load(args.idOrSlug),
    }),

    orgs: t.field({
      type: "OrgConnection",
      description: "Catalog-shaped page of organizations, newest first.",
      args: {
        page: t.arg.int({ required: false, defaultValue: 1 }),
        limit: t.arg.int({ required: false, defaultValue: DEFAULT_PAGE_SIZE }),
      },
      resolve: async (_root, args, ctx) => {
        const pageSize = clampLimit(args.limit);
        const page = Math.max(1, args.page ?? 1);
        const offset = (page - 1) * pageSize;
        const where = isNull(organizations.deletedAt);
        const [items, [{ n: totalItems }]] = await Promise.all([
          ctx.db
            .select()
            .from(organizations)
            .where(where)
            // Tiebreak on id: createdAt is millisecond-precision ISO strings
            // and bulk inserts collide; without the secondary key, page
            // boundaries shuffle between requests.
            .orderBy(desc(organizations.createdAt), desc(organizations.id))
            .limit(pageSize)
            .offset(offset),
          ctx.db
            .select({ n: sql<number>`count(*)` })
            .from(organizations)
            .where(where),
        ]);
        return {
          items,
          pagination: computePagination({
            page,
            pageSize,
            returned: items.length,
            totalItems: Number(totalItems),
          }),
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
        "Feed-shaped slice of recent visible releases. Pass `cursor` from the previous page's `nextCursor` to fetch the next slice.",
      args: {
        limit: t.arg.int({ required: false, defaultValue: DEFAULT_PAGE_SIZE }),
        cursor: t.arg.string({ required: false }),
        orgIdOrSlug: t.arg.string({ required: false }),
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
              excludeFilter,
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
