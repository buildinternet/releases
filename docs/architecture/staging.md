# Staging

The `api` and `mcp` workers have a `[env.staging]` block in their `wrangler.jsonc`. Webhooks, crons, and Vectorize are intentionally absent — staging is a read-surface for UI/API iteration, not a full replica.

- **Hosts:** `api-staging.releases.sh`, `mcp-staging.releases.sh`
- **Deployed as:** `releases-api-staging`, `releases-mcp-staging`
- **DB:** `released-db-staging` (separate D1), refreshed on demand from prod
- **Crons:** disabled (`CRON_ENABLED=false`, no cron triggers)
- **Vectorize:** no bindings — search degrades to FTS; `/v1/related/*` returns `degraded: true`
- **R2:** reuses `released-media` (read-only in practice; no cron writes)
- **KV:** reuses the existing preview namespaces, so `wrangler dev` and staging share cache
- **Indexing:** `INDEXING_DISABLED=true` — every response carries `X-Robots-Tag: noindex, nofollow` and `/robots.txt` returns `Disallow: /`
- **Access gate:** both hosts require the staging access key on every request. Missing/invalid → 401. The gate runs before routing, so public-read and admin endpoints are equally protected; CORS preflight (OPTIONS) passes through, as does `/api/auth/jwks` (public key material a resource server fetches server-to-server to verify OAuth JWTs — `STAGING_GATE_EXEMPT_PATHS`). The secret is bound via Secrets Store (`STAGING_ACCESS_KEY`) in `apps/api/wrangler.jsonc` and `apps/mcp/wrangler.jsonc` staging blocks. `api-staging` accepts the key via `X-Releases-Staging-Key` only. `mcp-staging` accepts it via `X-Releases-Staging-Key` or `Authorization: Bearer <key>`. Cloudflare Access (SSO) is still the long-term target — see issue #444.

Deploy:

```bash
# From workflow_dispatch on deploy-workers.yml with environment=staging, or:
bunx wrangler deploy --env staging --config apps/api/wrangler.jsonc
bunx wrangler deploy --env staging --config apps/mcp/wrangler.jsonc
```

Refresh staging data from prod:

```bash
# Locally (requires `wrangler whoami` in the Build Internet account):
./scripts/sync-staging-db.sh

# Or via GH Actions: run the "Sync staging DB" workflow with confirm="yes".
```

The sync script copies a content subset — orgs, products, sources, releases, tags, media, knowledge pages, source changelog files, coverage — and skips observability/webhook/vectorize tables (see the TABLES list at the top of `scripts/sync-staging-db.sh`). It also copies `d1_migrations` so staging's wrangler log mirrors prod's; this self-heals the "schema is ahead of the migration log" drift that happens when DDL gets applied to staging out-of-band.

When iterating on a new migration against staging, use `bunx wrangler d1 migrations apply DB --env staging --remote --config apps/api/wrangler.jsonc` — this applies the SQL and records the row in `d1_migrations`. Don't `wrangler d1 execute --env staging --file apps/api/migrations/...` to test a migration; that lands the schema but not the log row, and the next CI deploy fails with `duplicate column`/`already exists`.
