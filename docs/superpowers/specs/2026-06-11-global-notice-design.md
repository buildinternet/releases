# 2026-06-11 — Site-wide notice + admin hub

## Goal

Give a local-only admin a way to publish a single site-wide notice that draws visitor
attention to a new feature, link, etc. The notice renders on the **public production
site** in one of two placements (home-page card or a thin top banner), with a
configurable color and an optional visitor-dismiss toggle. There is never more than one
notice. As part of this work, move the admin destinations (status, API tokens, the new
site-notice manager) under a single **Admin** entry in the logged-in user dropdown.

## Access model

- **Management is local-only**, exactly like the existing status dashboard: the admin
  pages call `notFound()` unless `isLocalAdminEnabled()` (not production + a configured
  server API key). In practice the operator runs the web app locally pointed at the prod
  API (`RELEASES_API_URL` + admin `RELEASES_API_KEY`), the same way entity notices and
  API tokens are managed today.
- **Display is public**: the notice is read by the production web frontend and shown to
  all visitors. The read path is unauthenticated, cached, and fail-open (any error → no
  banner).

## Storage — generic `site_settings` table

A new worker-local table (follows the `user_follows` / `user_digest_prefs` /
`user_feed_tokens` island pattern — **not** core's composite schema, since only the API
worker queries it; the web reads through the API):

```
site_settings(
  key        text primary key,   -- e.g. "site_notice"
  value      text not null,       -- JSON blob
  updated_at integer not null     -- epoch ms
)
```

- Migration lives in `workers/api/migrations/`.
- The table is generic so future ad-hoc site config can take its own key + typed route.
- "Never more than one notice" is structural: one row, fixed key `site_notice`.

### Notice value shape

TS type + constants in zod-free `packages/core/src/site-notice.ts`; the zod validation
schema in `packages/api-types` (matches the established core-is-zod-free split).

```ts
SiteNotice {
  active: boolean
  message: string          // ≤280 chars (required)
  linkText?: string        // ≤60 chars
  href?: string            // absolute http(s) OR site-relative "/path", ≤500 chars
  placement: "home" | "banner"
  color: string            // hex "#rrggbb", default "#0081e7"
  dismissible: boolean      // default false
}
```

- `SITE_NOTICE_KEY = "site_notice"` constant in core.
- `DEFAULT_SITE_NOTICE_COLOR = "#0081e7"` (brand blue) in core.
- `linkText` is only meaningful when `href` is set; `href` may be omitted for a plain
  message.

## API worker — two purpose-built routes

- **`GET /v1/site-notice`** — public, unauthenticated, cached. Returns
  `{ notice: SiteNotice } | { notice: null }`. Fail-open. Carries an OpenAPI annotation
  for the coverage gate.
- **`PUT /v1/site-notice`** — admin scope (root key / `admin`). Validates the body
  against the api-types schema, upserts the `site_notice` key (sets `updated_at`).
  Returns the stored notice. No OpenAPI annotation (admin routes are exempt).

We deliberately do **not** expose a generic `GET /v1/settings/:key` publicly — that would
leak arbitrary future settings. The generic table stays an internal storage detail; the
notice gets a tight, typed public surface. A small typed accessor
(`getSetting`/`setSetting` keyed by string, JSON (de)serialized) wraps the table so future
settings reuse it.

## Web — admin pages (local-only)

- **`/admin`** — new hub index page. `isLocalAdminEnabled()` → `notFound()` otherwise.
  Lists the admin tools as cards/links with one-line descriptions: **Status**
  (`/admin/status`), **API tokens** (`/admin/api-tokens`), **Site notice**
  (`/admin/site-notice`).
- **`/admin/site-notice`** — the management form. Same local-only gate. Fields:
  - `active` toggle
  - `message` (textarea, ≤280, char counter)
  - `linkText` (≤60) + `href` (≤500, validated absolute http(s) or `/`-relative)
  - `placement` — radio: **Home card** / **Top banner**
  - `color` — 5 preset swatches that fill a hex input; default `#0081e7`. Free hex entry
    allowed.
  - `dismissible` toggle (default off)
  - **Live preview** of the rendered banner/card using the current form state.
  - Submits via a `setSiteNoticeAction` server action → `PUT /v1/site-notice` with the
    server-side Bearer (mirrors `setOrgNoticeAction` in `web/src/app/actions/`).

## Web — public rendering

A shared `getSiteNotice()` reader (`fetchApi`, ~60s ISR revalidate, fail-open → returns
`null` on any error) feeds two presentational mounts:

- **Top banner** — `<SiteNoticeBanner>` mounted in the root layout
  (`web/src/app/layout.tsx`) above the header. Renders a thin full-width bar only when
  `active && placement === "banner"`.
- **Home card** — `<SiteNoticeCard>` mounted on the homepage route. Renders only when
  `active && placement === "home"`.

Color handling: the chosen hex is the solid background; the foreground text color is
auto-derived for contrast by `readableTextColor(hex)` (pure helper in
`packages/core/src/site-notice.ts`, luminance threshold → black/white), so it reads
correctly in both light and dark mode with no per-variant juggling.

Dismissal: `dismissible` applies to **both** placements (default off). When on, a thin
client wrapper hides the notice after the visitor closes it and persists the dismissal in
`localStorage` keyed on `updated_at`, so editing/publishing a fresh notice re-shows it to
everyone.

Caching note: because the operator writes to the prod API from a local admin session, the
prod web cache is not busted by a local `revalidatePath`. The ~60s ISR window on
`getSiteNotice()` means a published/edited notice appears within ~a minute, not instantly.
Accepted for an ad-hoc notice.

## Web — dropdown change

In `web/src/components/account-nav.tsx`, add a single **Admin ›** link to `/admin`, shown
only when admin is enabled. Visibility is driven by a server-computed `adminEnabled` prop
threaded into the nav (fallback to the existing `statusDashboard` dev flag if the nav sits
in a fully-client tree). The pages enforce the real server gate regardless, so the link is
cosmetic. The existing `/admin/status` route is unchanged — it's now reachable via the hub
rather than being orphaned.

## Components & boundaries

| Unit                             | Path                                       | Responsibility                                                | Depends on                  |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------- | --------------------------- |
| `SiteNotice` type + helpers      | `packages/core/src/site-notice.ts`         | type, `SITE_NOTICE_KEY`, default color, `readableTextColor()` | nothing                     |
| Notice schema                    | `packages/api-types`                       | zod validation of the write body / response                   | core type                   |
| `site_settings` table + accessor | `workers/api/src/db/` (island) + migration | persistence, `getSetting`/`setSetting`                        | drizzle/D1                  |
| Notice routes                    | `workers/api/src/routes/`                  | `GET` public + `PUT` admin                                    | accessor, schema, auth gate |
| Admin hub page                   | `web/src/app/admin/page.tsx`               | list admin tools                                              | local-admin gate            |
| Notice admin page + form         | `web/src/app/admin/site-notice/`           | edit form + live preview                                      | server action               |
| Server action                    | `web/src/app/actions/`                     | `setSiteNoticeAction` → API PUT                               | admin-action env            |
| Public reader                    | `web/src/lib/`                             | `getSiteNotice()` cached fetch                                | `fetchApi`                  |
| Banner + card                    | `web/src/components/`                      | presentational render + contrast + dismiss                    | core helper                 |
| Dropdown link                    | `web/src/components/account-nav.tsx`       | Admin entry                                                   | `adminEnabled` prop         |

## Testing

- **Worker routes**: `GET` returns `null` when unset and the notice when set; `PUT`
  rejects a non-admin caller (401/403), validates message length / placement enum / href
  format / color hex, and upserts idempotently (second PUT replaces, still one row).
- **api-types schema**: accepts a valid notice; rejects over-length message, bad
  placement, malformed href, non-hex color.
- **core**: `readableTextColor()` returns dark text on light backgrounds and light text on
  dark backgrounds (boundary cases around the luminance threshold).
- **web**: `setSiteNoticeAction` refuses when admin gate is off; banner/card render logic
  honors `active`, `placement`, and `dismissible`.

## Out of scope (YAGNI)

- A generic public settings API or multi-setting admin UI (only the notice is built; the
  table is merely generic-ready).
- Scheduling / auto-expiry of notices.
- Multiple concurrent notices or per-audience targeting.
- Rich text / markdown in the message (plain text + one optional link only).
- Busting the prod web cache on write (the ISR window is acceptable).
