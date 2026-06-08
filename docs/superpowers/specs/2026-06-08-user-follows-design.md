# User Follows + Personalized Feed — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming) → pending implementation plan

## Goal

Let a signed-in user follow organizations and products, and read a personalized
feed of releases from everything they follow. This is the foundation for a daily/
weekly digest email later, but **email and per-user RSS/Atom are out of scope for
this build** — they get their own specs.

## Scope

In scope:

- Follow / unfollow **organizations and products** (two granularities).
- "Org follow = everything" semantics: following an org surfaces releases from the
  org itself _and_ all of its products; following a product narrows to that product.
- New REST surface under `/v1/me/*`, session-authed (Better Auth cookie).
- Web: a follow button on org/product detail pages, and a top-level `/following`
  feed page that also manages (lists/removes) who you follow.

Explicitly deferred (separate specs):

- Daily/weekly digest emails.
- Per-user authenticated RSS/Atom feed.
- CLI / MCP follow verbs (wire types are added now so adoption is additive later).

## Data model

One new table. It is **user-coupled**, so by the repo convention it lives in a
**worker-local schema island** — a new `workers/api/src/db/schema-follows.ts`,
sibling to `schema-auth.ts` — and is deliberately **not** added to the published
`@buildinternet/releases-core` schema (the OSS CLI has no business with a user's
follows). The table is registered in the worker's drizzle schema map
(`workers/api/src/db.ts`) so `createDb(...)` can query it.

```
user_follows
  id           text   primary key
  user_id      text   not null  -> user(id) ON DELETE CASCADE   (indexed)
  target_type  text   not null  enum: 'org' | 'product'
  target_id    text   not null  (typed entity id: org_… / prd_…)
  created_at   integer timestamp not null
  UNIQUE(user_id, target_type, target_id)
```

**Polymorphic `(target_type, target_id)`, chosen over two nullable FK columns
(`org_id` / `product_id` + CHECK).** Rationale:

- Simpler schema and migration; generalizes cleanly if source-level follows are
  ever added.
- The only thing given up is a hard cascade FK on the target. That does not matter
  here: orgs/products are _soft_-deleted (`deletedAt` tombstone), not hard-deleted,
  and the feed query inner-joins to live (visible) entities — so an orphaned follow
  is simply invisible, never broken.
- Follow-time validation rejects a `targetId` that does not resolve to an existing,
  visible org/product, so orphans are rare by construction.

`user_id` keeps a real FK with `ON DELETE CASCADE` (same island as `user`), so
deleting an account removes its follows.

Paired migration: `workers/api/migrations/<timestamp>_add_user_follows.sql`
(the schema↔migration CI gate requires this for any new table).

## API

New `/v1/me/*` surface, session-authed via the Better Auth cookie. The browser
calls these endpoints **directly** at `api.releases.sh` with `credentials:
"include"` — identical to existing Better Auth client traffic — so the routes need
the credentialed, origin-reflecting `authCorsMiddleware()` plus a carve-out from
the wildcard `publicReadCors`, exactly mirroring the existing `/v1/api-keys`
treatment in `workers/api/src/index.ts`.

Gating:

- Flagship Tier-1 flag `user-follows-enabled` (added to the `FLAGS` registry and
  created in both `releases-platform{,-staging}` apps). Off → the surface is dark
  (404), same shape as the api-keys flag.
- A session gate. The existing `requireSession` middleware is currently hard-wired
  to the api-keys flag; generalize it to take a flag argument so both surfaces
  share one cookie-session resolution path. No session → 401.

Endpoints:

| Method   | Path                                   | Behavior                                                                                                                                                          |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/v1/me/follows`                       | List the caller's follows, each enriched with the target's name / slug / avatarUrl for rendering.                                                                 |
| `POST`   | `/v1/me/follows`                       | Body `{ targetType: 'org' \| 'product', targetId }`. Idempotent (re-follow is a no-op success). Validates the target exists and is visible; unknown/hidden → 404. |
| `DELETE` | `/v1/me/follows/:targetType/:targetId` | Idempotent unfollow (removing a non-follow is a success).                                                                                                         |
| `GET`    | `/v1/me/feed?cursor=&limit=`           | Personalized release feed.                                                                                                                                        |

**Feed query** (encodes the "org follow = everything" semantics):

1. Resolve the caller's follows into a set of followed org ids and followed product ids.
2. Select from `releases_visible` JOIN `sources_visible` WHERE
   `source.org_id IN (followed orgs)` **OR** `source.product_id IN (followed
products)`.
3. Order `published_at DESC, id DESC` (covered by the existing
   `idx_releases_published_id` index), apply the existing coverage-side hiding, and
   page with the existing cursor shape used by the other release-list routes.
4. Empty follow set → empty feed (no query against an empty `IN (...)`).

D1's 100-bound-parameter limit applies to the `IN (...)` lists; chunk the id lists
the same way the existing `inArray` lookups do (90 ids/chunk) if a user follows
more than that many entities.

## Web (Next.js)

- **`FollowButton`** — a client component placed on org and product detail pages.
  Renders only when the auth UI is enabled and a session exists; otherwise null
  (no layout shift for signed-out / flag-off).
- **Follow-state without SSR coupling.** Detail pages are server-rendered using the
  server-to-server proxy key, _not_ the user's session, so per-entity
  `isFollowing` cannot come from the SSR payload cheaply. Instead a small
  client-side follows provider fetches `GET /v1/me/follows` once on mount and
  exposes the followed-id set; each `FollowButton` looks itself up there and issues
  `POST` / `DELETE` optimistically. One cheap browser request rather than threading
  the session cookie through every SSR proxy call.
- **`/following`** — a top-level client page. Fetches `GET /v1/me/feed` and renders
  releases with the existing release-card components. The **manage-follows list
  lives on the same page** (a section/sidebar listing followed orgs/products with a
  remove control), not under `/account`. Gated by a `NEXT_PUBLIC_*` flag mirroring
  the `AUTH_UI_ENABLED` pattern; signed-out visitors get a sign-in prompt.

## Wire types

`packages/api-types`: add `FollowTarget` (`'org' | 'product'`), `Follow` (the
enriched list item), the follow request/response shapes, and the personalized-feed
response shape (reusing the existing release list-item type). Additive — the CLI/MCP
can adopt these later without a breaking change.

## Testing

- **Follows store:** idempotent follow, idempotent unfollow, list returns the
  caller's rows only, unique constraint holds.
- **Feed semantics:** the key assertion — following an _org_ returns releases from
  that org's _products_, not just org-direct sources; following a _product_ returns
  only that product; combined follows union correctly; suppressed / coverage-side /
  hidden-source rows are excluded.
- **Auth gating:** no session → 401; flag off → 404; one user cannot read another
  user's follows or feed.
- Use the existing injected-`betterAuth` / session test seam in the API test
  harness.

## Out of scope (recap)

Digest emails, per-user RSS/Atom, and CLI/MCP follow verbs are deferred to their own
specs. The data model and wire types are shaped so those can be added additively.
