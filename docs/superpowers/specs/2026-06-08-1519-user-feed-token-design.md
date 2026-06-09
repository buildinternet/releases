# 1519 — Per-user authenticated RSS/Atom feed

**Issue:** [#1519](https://github.com/buildinternet/releases/issues/1519) — follow-up to user follows + personalized feed (PR #1514, live in prod).

## Goal

Expose each signed-in user's personalized follows feed (`getFollowedReleases`) as a
tokenized Atom URL they can paste into a feed reader. The feed is personal, so it
must be authenticated — but a feed reader can't send a cookie or a custom header
reliably, so the credential rides in the URL as an opaque per-user **feed token**.

## Decisions (locked)

1. **Token model** — a dedicated `relf_` feed token (its own table), independently
   mint/rotate/revoke without touching the user's API keys or session.
2. **Served from** — the API worker directly (`api.releases.sh`). The data lives in
   the worker (`getFollowedReleases`), it's private (must not sit on a CDN edge like
   the public `.atom` feeds), and serving inline avoids forwarding a secret web→API.
3. **URL shape** — secret in the **path**, a **single rotatable token per user**.
   `https://api.releases.sh/v1/feed/relf_<lookupId>_<secret>.atom`.
4. **Web UI** — a "Your feed" card on the existing `/following` page (copy / rotate /
   revoke).
5. **No feature flag** — the cookie session (management lane) and the token (read
   lane) are the only gates, consistent with how follows shipped.
6. **Reversible token (re-revealable)** — the feed serves only publicly-available
   release data and carries no PII or identity, so the token is stored recoverably
   and the full feed URL can be re-displayed on every visit (the calendar-`.ics`
   model), not shown once. The UI warns the user to keep the URL private (anyone
   holding it can read their follow list's feed); losing it is a rotate, not a
   re-subscribe.

## Token

### Wire format

`relf_<lookupId>_<secret>` — mirrors `relk_` exactly: 12-char base62 `lookupId`
(non-secret, indexed) + 32-char base62 `secret` (~190 bits, CSPRNG). Per decision 6
the token is stored **recoverably** — the `secret` is persisted plaintext (not
hashed) so the management lane can re-display the full feed URL on any visit.

Added to `packages/core/src/api-token.ts` (pure, zod-free — good fit):

- `FEED_TOKEN_PREFIX = "relf_"`
- `generateFeedToken(): GeneratedApiToken` — reuses the existing base62 generators.
- `parseFeedToken(raw): { lookupId, secret } | null`
- `isFeedTokenShaped(raw): boolean`

Reuses the existing `constantTimeEqual()` verbatim for secret comparison (no
hashing — the secret is stored plaintext per decision 6). The `relf_` lane is
**only** ever presented in the `/v1/feed/:token` path — never as a Bearer — so it
never reaches the global auth middleware and needs no routing there.

### Storage

New worker-local schema island `workers/api/src/db/schema-feed-tokens.ts` (sibling of
`schema-follows.ts` / `schema-auth.ts`), table `user_feed_tokens`, **one row per
user**:

| column         | type                | notes                                         |
| -------------- | ------------------- | --------------------------------------------- |
| `id`           | text PK             | typed `uft_…`                                 |
| `user_id`      | text NOT NULL       | FK → `user(id)` ON DELETE CASCADE; **unique** |
| `lookup_id`    | text NOT NULL       | plaintext, unique-indexed (resolve key)       |
| `secret`       | text NOT NULL       | plaintext secret (reversible; see decision 6) |
| `created_at`   | integer (timestamp) | `$defaultFn(() => new Date())`                |
| `last_used_at` | integer (timestamp) | nullable; best-effort on each feed fetch      |

Indexes: `uniqueIndex(user_id)` (one token per user), `uniqueIndex(lookup_id)`
(resolve path).

Because there's one row per user: **mint and rotate are the same upsert** (generate a
new secret + lookupId, replace the row → the old feed URL stops resolving); **revoke
deletes the row** (the URL 404s).

Paired migration `workers/api/migrations/<ts>_add_user_feed_tokens.sql` (the schema
island needs a paired migration, same as `schema-follows` did).

## Endpoints

### Read lane — public, secret in path, no session

`GET /v1/feed/:token`

- `:token` accepts a `.atom` or `.rss` suffix (stripped in-handler) or bare; both
  serve the same Atom document (every reader accepts Atom — a separate RSS-2.0
  serializer is YAGNI).
- Resolve: `parseFeedToken` → `SELECT … WHERE lookup_id = ?` →
  `constantTimeEqual(secret, row.secret)` → `userId`.
- On match: `getFollowedReleases(db, userId, { limit: ATOM_DEFAULT_MAX_ENTRIES })` →
  `userFeedToAtom(...)`.
- Headers: `Content-Type: application/atom+xml; charset=utf-8`,
  `Cache-Control: private, no-store`, `ETag` + conditional `304` via the existing
  `atom-http` helpers (`atomEtag` / `shouldReturn304`).
- **Invalid, malformed, or revoked token → 404** (opaque; non-enumerable — never 401,
  which would confirm the path).
- Empty follows → a valid empty Atom feed (200), so the reader stays subscribed.
- `last_used_at` updated best-effort via `executionCtx.waitUntil` (never blocks or
  fails the response).

### Management lane — cookie session, under `requireFollowsSession`

Registered in the existing `meHandlers` / `meRoutes` (`workers/api/src/routes/me.ts`),
so unit tests mount them behind an injected session exactly like the follows handlers.
Nested under `/me/feed` (the token is a sub-resource of the personalized feed — avoids
a kebab compound noun):

- `GET /v1/me/feed/token` → `{ token: FeedToken | null }` — includes the **full
  re-revealable `feedUrl`** (decision 6), so the UI can show + copy it on any visit.
- `POST /v1/me/feed/token` → mint-or-rotate; returns the `FeedToken` (new `feedUrl`).
- `DELETE /v1/me/feed/token` → revoke (delete the row); `{ success: true }`.

`feedUrl` is built from the API worker's own request origin
(`new URL(c.req.url).origin` → `https://api.releases.sh` in prod, local-correct in
dev) — the feed is served by this worker, so the URL must point back at it:
`<apiOrigin>/v1/feed/<token>.atom`. (This is distinct from the rendering `baseUrl`,
which is `WEB_BASE_URL` and drives entry/alternate links into the web app.)

## Rendering

New formatter in `packages/rendering/src/atom.ts`:

```ts
export function userFeedToAtom(
  params: { releases: ReleaseLatestItem[]; lookupId: string; selfUrl: string },
  opts: AtomFeedOptions,
): string;
```

- Add `"user"` to the `FeedShell.scope` union.
- Maps `ReleaseLatestItem[]` → `EntryInput[]`: `sourceSlug = release.source.slug`,
  `sourceName = release.source.name`, `orgName = null` (author falls back to source
  name, which is correct for a cross-org feed), `linkHref = release.id ?
${baseUrl}/release/${release.id} : release.url`.
- Feed-level: `scope: "user"`, `slug: lookupId` (non-secret, stable per token →
  stable `feedId` tag URI), `title: "Your followed releases"`, `subtitle:
"Releases from the organizations and products you follow on Releases."`,
  `selfUrl` = the tokenized feed URL (standard for tokenized feeds — it's what the
  reader already holds), `alternateUrl: ${baseUrl}/following`, `authorName:
"Releases"`.

`opts.baseUrl` = `WEB_BASE_URL` (defaults `https://releases.sh`) so entry links and
the alternate link point at the web app, matching every other feed.

## Web UI — "Your feed" card on `/following`

In `web/src/app/following/following-client.tsx`, add a card that talks to the
management endpoints with credentialed (cookie) fetch:

- **No token:** "Generate a private feed URL" button → `POST` → reveal the URL with a
  **Copy** button.
- **Has token:** the full `feedUrl` (re-revealable via `GET`), a **Copy** button,
  `created` / `last fetched` timestamps, **Rotate** (confirm — warns it breaks
  existing reader subscriptions), **Revoke** (confirm).
- A short inline note: _"Keep this URL private — anyone with it can read your feed.
  Rotate to invalidate the old one."_ (Decision 6 — the data is public, but the URL
  is still personal to your follow list.)

## api-types

Additive wire type in `packages/api-types` (consumed by web). One shape serves both
`GET` (wrapped in `{ token }`) and `POST`, since the token is re-revealable:

- `FeedToken` — `{ feedUrl: string; lookupId: string; createdAt: string; lastUsedAt: string | null }`

## Error handling summary

| Condition                      | Response                               |
| ------------------------------ | -------------------------------------- |
| Malformed / wrong-prefix token | 404                                    |
| Unknown `lookupId`             | 404                                    |
| Secret mismatch                | 404 (constant-time compare)            |
| Revoked (row deleted)          | 404                                    |
| Valid token, zero follows      | 200, well-formed empty Atom feed       |
| Management lane, no session    | 401 (existing `requireFollowsSession`) |

## Testing

- **Core** (`packages/core`): `generateFeedToken` → `parseFeedToken` round-trip;
  prefix/shape checks; `constantTimeEqual` accept/reject.
- **Rendering** (`packages/rendering`): `userFeedToAtom` snapshot — entries, self/alt
  links, `feedId` from `lookupId`, empty-feed case.
- **Routes** (`workers/api/test`): feed render for a resolvable token; 404 for
  malformed / unknown / revoked; `GET/POST/DELETE /me/feed/token` behind an injected
  session (mirrors `follows-routes.test.ts`); rotate invalidates the previous secret;
  `last_used_at` write doesn't block the response.

## Out of scope (follow-ups)

- A dedicated RSS-2.0 serializer (Atom satisfies all readers).
- Multiple named feed tokens per user.
- Digest-email reuse of the same token lane (#1518 owns email).
- CLI/MCP surfacing of the feed URL.
