# Follows: daily/weekly digest emails

**Issue:** [#1518](https://github.com/buildinternet/releases/issues/1518)
**Depends on:** user follows + personalized feed (PR #1514, live), per-user RSS/Atom feed + `relf_` token (PR #1529, live)
**Status:** design approved 2026-06-09

> **Amendment (2026-06-09, post-implementation):** the `digest-emails-enabled`
> Flagship flag described below was **dropped** before merge — digests ship
> enabled with no feature flag, matching the follows feature. The per-user opt-in
> (cadence defaults to `off`) plus the existing `CRON_ENABLED` operational switch
> are the only gates. References to the flag in the sections below are historical.
> A root-key `POST /v1/admin/digest/test` on-demand test-send was also added for
> development (bypasses the schedule + verified-email filter; never advances the
> watermark unless asked).

## Summary

Opt-in daily/weekly email digests of new releases from the orgs/products a signed-in
user follows. The follows model + `getFollowedReleases` query were built explicitly as
the foundation for this — digests are the original motivation for the follows feature.

Per-user cadence preference (`off` / `daily` / `weekly`, default `off`). Two crons
(daily, weekly-Monday) gather each subscribed user's releases published since their last
digest and send a grouped summary from `digests@releases.sh`. A signed-token one-click
unsubscribe lane (no login required) plus an authed cadence toggle on `/following`.

## Decisions (locked)

| Decision                | Choice                                                                                  | Rationale                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender                  | `digests@releases.sh` via the existing `AUTH_EMAIL` Email-Sending binding               | Product brand is Releases; `releases.sh` is already SPF/DKIM-verified for Email Sending and delivers to arbitrary recipients. (Issue noted `rally.space`, but that would need a new domain verification.) |
| "New since last digest" | **Published date** — `published_at > last_digest_at`                                    | Matches the literal "recently shipped" intuition. Accepted tradeoff: backdated/backfilled entries (common in this product) whose `published_at` is below the watermark are not surfaced.                  |
| Opt-in                  | Default `off`; cadence toggle on the existing `/following` page                         | No emails until explicitly enabled; no new top-level settings page.                                                                                                                                       |
| Unsubscribe             | Per-user opaque `reld_` token → no-login one-click + RFC 8058 `List-Unsubscribe` header | Email recipients may have no active session; token-based is the robust, deliverability-friendly path.                                                                                                     |
| Send mechanism          | Plain cron module + sequential capped send (Approach A)                                 | Simplest; fits the current small user base. Data model is shaped so the send loop can be swapped for a Workflow / Queue later with no schema change.                                                      |

### Send-mechanism alternatives considered

- **A — Plain cron module + sequential capped send** (like `cron/well-known-sync.ts`). **Chosen.**
- **B — Cloudflare Workflow** (durable per-user steps, like `batch-summarize`). Resumable, but overkill until a single cron invocation can't finish within Worker limits.
- **C — Queue fan-out** (cron enqueues per-user → Queue consumer sends). Best retry isolation/scale, most infra.

Recommendation stands at A; the prefs row + watermark are the only durable state, so B or C can replace `sendDigests`' inner loop later without a migration.

## Data model

One new **worker-local schema island** — `workers/api/src/db/schema-digest-prefs.ts`,
sibling to `schema-follows.ts` / `schema-feed-tokens.ts`. User-coupled, so deliberately
**not** added to the published `@buildinternet/releases-core` schema. Registered in the
worker drizzle schema map (`workers/api/src/db.ts`) so `createDb(...)` can query it.
Paired migration `workers/api/migrations/<timestamp>_add_user_digest_prefs.sql` (the
schema↔migration CI gate requires this for any new table).

```
user_digest_prefs
  user_id        text   primary key  -> user(id) ON DELETE CASCADE
  cadence        text   not null default 'off'   -- 'off' | 'daily' | 'weekly'
  last_digest_at integer             -- watermark: published-at cutoff already covered (epoch ms); null until first enable
  manage_token   text   not null unique  -- opaque 'reld_<lookupId>_<secret>'-style token for the no-login lane
  created_at     integer not null
  updated_at     integer not null
```

- `user_id` keeps a real FK with `ON DELETE CASCADE` (same island as `user`), so deleting
  an account removes its digest prefs.
- The row is created lazily on the first `PUT /v1/me/digest` (or first follow-with-digest
  action); absence of a row == cadence `off`.
- `manage_token` is a reversible/plaintext-secret opaque token (mirrors the `relf_` feed
  token: this is a low-sensitivity action over public-ish data — it only toggles a user's
  own digest off). Prefix `reld_`. Generated when the row is created; rotatable later if
  needed (not in scope).

## Watermark semantics (published-date basis)

`last_digest_at` is the **content watermark only** — it does not drive scheduling (the two
crons do).

- **On enable** (`off` → `daily`/`weekly`): set `last_digest_at = now`. The first digest
  covers only releases published _after_ opt-in.
- **Per cron run** for cadence `C`, per due user: gather via a watermarked
  `getFollowedReleases` — `published_at > last_digest_at AND published_at <= runStart`,
  ordered `published_at DESC`, capped at `DIGEST_MAX_RELEASES` (~50). Reuses the existing
  org-follow=its-products / suppressed / coverage-side / hidden-source / deleted-org
  filtering already in `getFollowedReleases`.
- **Empty gather → no send, watermark unchanged.** No empty digests; a late-ingesting item
  published within the window is still caught on the next run.
- **Non-empty gather → send, then set `last_digest_at = runStart`.**
- Rows with null `published_at` are excluded (can't be placed on the watermark).
- Backdated entries whose `published_at` falls below an already-advanced watermark are not
  surfaced — the accepted tradeoff of the published-date basis.

## Cron

Two new triggers in `workers/api/wrangler.jsonc` (prod only — staging has no crons), both
dispatching a new `sendDigests(env, { cadence, runStart })` module from `scheduled()`:

| Trigger                         | Cadence processed |
| ------------------------------- | ----------------- |
| `0 13 * * *` (daily 13:00 UTC)  | `daily`           |
| `0 13 * * 1` (Monday 13:00 UTC) | `weekly`          |

`sendDigests` flow:

1. **Gate:** no-op if `!CRON_ENABLED` or the `digest-emails-enabled` flag is off.
2. **Select recipients:** `user_digest_prefs` rows with `cadence = C`, joined to the auth
   `user` table for `email` / `name`, filtered to **`user.emailVerified = 1`** (never send
   to unverified addresses). Cap the batch at `DIGEST_MAX_PER_RUN`.
3. **Per user:** watermarked gather → if empty, skip (no watermark change); else render the
   digest (HTML + text) → send via `AUTH_EMAIL` from `DIGEST_EMAIL_FROM` → on a successful
   send, set `last_digest_at = runStart` and `updated_at = now`.
4. Emit a `logEvent` summary (counts: considered / sent / skipped-empty / failed). Failures
   are logged and the loop continues (the send helper never throws).

Scheduling is purely "which cron fired" — a weekly user who enables mid-week gets their
first digest on the next Monday run, covering `published_at > enabled_at`.

### Kill-switch flag

`digest-emails-enabled` (Flagship Tier-1, default **off**, created in both
`releases-platform{,-staging}` apps; registered in `@releases/lib/flags`). This is one of
the cases where a flag earns its keep per AGENTS.md: it sends real mail to real users, so a
bug is inbox spam — a runtime kill switch is warranted. Ship off, verify in prod, then flip
on.

## Email send + template

New `workers/api/src/lib/digest-email.ts`:

- Wraps the existing **`AUTH_EMAIL`** Email-Sending binding (the one that reaches arbitrary
  recipients), from a new `DIGEST_EMAIL_FROM=digests@releases.sh` var. Never throws — logs
  and returns `{ sent: false, reason }` on a missing binding / send error, like
  `sendAuthEmail`, so the cron loop can fire-and-forget.
- **Subject:** e.g. `Your daily Releases digest — 5 updates` / `…weekly…`.
- **Body (HTML + text):** releases grouped org → product → release, each showing
  `title_short` / `title_generated` / `title` (first non-empty), a short summary, the
  published date, and a link to the release page on `releases.sh`.
- **Footer:** **Manage preferences** (→ `/following`) and one-click **Unsubscribe** (the
  `reld_` token URL).
- **`List-Unsubscribe` + `List-Unsubscribe-Post` headers** (RFC 8058) via the binding's
  `headers` object — confirmed supported by Cloudflare Email Service (custom non-reserved
  headers are allowlisted; From/To/Subject must stay in the API fields). The current
  `AuthEmailBinding` type in `src/auth/email.ts` does not declare `headers`, so the plan
  adds an optional `headers?: Record<string, string>` field to it. The in-body unsubscribe
  link is kept as a belt-and-suspenders fallback.

## Endpoints

### Authed cadence toggle — `/v1/me/digest`

Gated like follows: a Better Auth **session OR a Bearer user principal** (`relu_` key /
OAuth JWT), reusing the `requireFollowsPrincipal` resolution path (not `relk_` / root /
anonymous — those have no owning user). CORS handled exactly as the existing `/v1/me/*`
surface (credentialed, origin-reflecting).

| Method | Path            | Behavior                                                                                                                                                             |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/me/digest` | Return `{ cadence }` for the caller (absent row → `off`).                                                                                                            |
| `PUT`  | `/v1/me/digest` | Body `{ cadence: 'off'\|'daily'\|'weekly' }`. Upserts the row; on `off`→on transition, stamps `last_digest_at = now` and mints `manage_token` if absent. Idempotent. |

### Public token lane — `/v1/digest/unsubscribe/:token`

Mounted off the `publicReadAuth` middleware and excluded from the OpenAPI coverage gate,
mirroring the `relf_` public feed lane. Opaque **404** on an unknown/malformed token (never
reveals whether a token exists).

| Method | Path                            | Behavior                                                                                 |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST` | `/v1/digest/unsubscribe/:token` | RFC 8058 one-click. Resolve token → set `cadence='off'`. Idempotent; opaque-404 on miss. |
| `GET`  | `/v1/digest/unsubscribe/:token` | Browser-click confirmation page/redirect that also sets `cadence='off'`.                 |

## Web (`/following`)

Add an **"Email digest"** card to the existing `/following` page, mirroring the #1519
"Your feed" RSS card: an Off / Daily / Weekly selector that reads `GET /v1/me/digest` on
mount and writes `PUT /v1/me/digest` on change. Reuses the shared web `user-api.ts` client.
Signed-out / flag-off → not rendered (consistent with the rest of `/following`).

## Wire types (`packages/api-types`, additive)

- `DigestCadence` = `'off' | 'daily' | 'weekly'`
- `DigestPrefs` response shape `{ cadence: DigestCadence }`
- the `PUT` request shape `{ cadence: DigestCadence }`

Additive — CLI/MCP can adopt later without a breaking change. Published on the next
`api-types` version bump.

## Config summary

- **Flag:** `digest-emails-enabled` (both Flagship apps, default off).
- **Vars** (`workers/api/wrangler.jsonc`): `DIGEST_EMAIL_FROM=digests@releases.sh`,
  `DIGEST_MAX_PER_RUN`, `DIGEST_MAX_RELEASES`.
- **Sender allowlist:** add `digests@releases.sh` to the `AUTH_EMAIL` binding's
  `allowed_sender_addresses` in **both** the prod and staging `send_email` blocks of
  `workers/api/wrangler.jsonc` (currently `["noreply@releases.sh"]`). `releases.sh` is
  already DKIM-verified for Email Sending, so no new domain verification is needed — only
  the per-address allowlist entry, or the binding rejects the `digests@` sender.
- **Crons:** two new triggers (prod only).
- **Migration:** `user_digest_prefs` island + paired SQL.

## Testing

- **Prefs store:** default-absent == `off`; first enable stamps `last_digest_at` and mints
  a `manage_token`; `PUT` is idempotent; `off` clears scheduling but keeps the row/token.
- **Watermark gather:** only `published_at` within `(last_digest_at, runStart]`; org-follow
  returns the org's products' releases; suppressed / coverage-side / hidden-source /
  deleted-org / null-`published_at` rows excluded; cap respected.
- **Cron:** empty gather → no send + no watermark advance; non-empty → send + watermark =
  `runStart`; only cadence-matching **and** `emailVerified` users selected; `digest-emails-
enabled` off or `CRON_ENABLED` off → no-op; one failed send doesn't abort the loop.
- **Unsubscribe token:** valid token → `cadence='off'`, idempotent; bad/malformed token →
  opaque 404; one user's token cannot affect another user's row.
- **Auth gating on `/v1/me/digest`:** session works; `relu_` / OAuth-JWT user works;
  `relk_` / root / anonymous → 401; one user cannot read/write another's cadence.

Use the existing injected-`betterAuth` / session test seam and the in-memory D1 fixture
helper (`tests/db-helper.ts`).

## Binding findings (resolved)

Both former open questions are resolved against the live config / Cloudflare docs:

1. **Custom headers — supported.** The Cloudflare Email Service `send()` accepts a `headers`
   object; `List-Unsubscribe` / `List-Unsubscribe-Post` are valid (reserved/platform headers
   and From/To/Cc/Bcc/Subject/Reply-To are rejected — those use the API fields). Limits: ≤20
   non-`X-` headers, 2 KB/value, 16 KB total. The plan extends `AuthEmailBinding` with an
   optional `headers?: Record<string, string>`.
2. **Sender address — allowlisted, not just domain-verified.** `releases.sh` is DKIM-verified
   for Email Sending, but the `AUTH_EMAIL` binding pins `allowed_sender_addresses` to
   `["noreply@releases.sh"]`. The plan must add `digests@releases.sh` to that array in **both**
   the prod and staging `send_email` blocks of `workers/api/wrangler.jsonc`, or the binding
   rejects the digest sender. No new domain verification needed.

## Out of scope

- Per-release / instant notifications (only daily/weekly batched).
- Digest content summarization via AI (uses existing stored `summary` / `title_*`).
- CLI/MCP cadence verbs (data model + wire types are additive for a later spec).
- `manage_token` rotation UI.
- Queue/Workflow send path (data model leaves the door open).
