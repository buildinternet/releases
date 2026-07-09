# Releases web

The Next.js frontend for `releases.sh` — the public registry UI (org/product/source/release
pages, search, collections, overviews) plus the signed-in account surface (follows, feed,
webhooks, API keys, workspaces). Talks to the API worker at `api.releases.sh` (REST + GraphQL).

## Layout

- `src/app/` — Next.js App Router routes: `[orgSlug]/`, `release/`, `catalog/`, `categories/`,
  `collections/`, `docs/`, `account/`, `admin/`, auth routes (`login/`, `oauth/`,
  `forgot-password/`, `reset-password/`, `accept-invitation/`, `device/`), `api/` route handlers,
  plus `robots.ts` and `opengraph-image.tsx`
- `src/components/` — shared React components (panels, cards, nav, auth forms, admin UI, etc.)
- `src/lib/` — client/server helpers: API + GraphQL clients, auth client, account/API-key helpers,
  atom feed, agent-launch, well-known config, and their colocated tests
- `src/hooks/` — React hooks
- `src/content/` — static/markdown content
- `src/flags.ts` — feature-flag reads
- `src/proxy.ts` — request proxy (with `proxy.test.ts`)
- `src/well-known-releases.test.ts` — tests for the `.well-known/releases.json` surface
- `next.config.ts` — Next.js config
- `codegen.ts` — GraphQL Codegen config (`bun run codegen`, generates typed documents against the
  API worker's GraphQL schema)
- `vercel.json` — Vercel framework/build settings; `ignoreCommand` runs
  `scripts/vercel-ignore.sh` (kept as a script so the command stays under Vercel's 256-char
  schema limit) and skips builds when a deploy has no changes under `web/`, `packages/`,
  `scripts/`, `bun.lock`, or `package.json`
- `public/` — static assets
- `scripts/build-well-known.ts` — build-time script (run from the `build` script) that generates
  the `.well-known` config output
- `scripts/vercel-ignore.sh` — ignored-build-step logic for Vercel (prod-only + path-filtered skip)

## Develop

`bun run dev:web` from the repo root — served via [portless](https://github.com/vercel-labs/portless)
at `https://releases.localhost`. Needs the API worker running alongside it (`bun run dev:api`) to
have any data to render.

Stack: Next.js + Tailwind CSS, consuming `@buildinternet/releases-api-types` for REST wire types
and `@releases/design-system` for the shared token/component vocabulary.

## Deploy

Deployed automatically on Vercel.

## Docs

- [web.md](../docs/architecture/web.md) — changelog range/slicing API, GitHub CHANGELOG
  ingestion, Open Graph images, org overviews, category overlay, collections, media pipeline, org
  avatars, follows/feed, admin hub
