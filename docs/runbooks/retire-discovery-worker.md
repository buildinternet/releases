# Retire the discovery worker (manual steps)

The repo side of #2352 removes `apps/discovery/`, the `DISCOVERY_WORKER` service
binding, `POST /v1/workflows/discover`, the managed-agent definitions, and their
deploy tooling. Three things live outside the repo and need an operator:

1. the two Cloudflare scripts and their `ManagedAgentsSession` Durable Object,
2. the Anthropic-side agents, environments, and memory stores,
3. the CLI release that stubs `releases admin discovery onboard`.

Nothing in the Secrets Store is discovery-only. Every secret the worker bound
(`RELEASED_API_KEY`, `RELEASES_API_KEY`, `ANTHROPIC_API_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `AI_GATEWAY_TOKEN`,
`AI_GATEWAY_TOKEN_STAGING`, `OPENROUTER_API_KEY`, `WEB_BOT_AUTH_PRIVATE_KEY`,
`STAGING_ACCESS_KEY`) is also bound by the API worker. Leave the store alone.

## Order

Merge the API-side removal first. Once `releases-api` no longer binds
`DISCOVERY_WORKER`, the discovery scripts have no callers and can be deleted at
any later time.

## 1. Delete the Cloudflare scripts

A script that still owns a Durable Object namespace can't be deleted until the
class is removed by a migration. Run this from the last commit that still has
`apps/discovery/wrangler.jsonc` (the parent of the retirement merge), with
`CLOUDFLARE_ACCOUNT_ID` set to the Build Internet account.

Edit `apps/discovery/wrangler.jsonc` in that checkout:

- delete the `durable_objects` block (prod and the `staging` env),
- append `{ "deleted_classes": ["ManagedAgentsSession"], "tag": "v6" }` to the
  prod `migrations` array and `{ "deleted_classes": ["ManagedAgentsSession"], "tag": "v4" }`
  to the staging one,
- delete the `DiscoveryEntrypoint` export and the DO class from `src/index.ts`
  if wrangler refuses to bundle a config that no longer declares them.

Then deploy the migration and delete each script:

```bash
bunx wrangler deploy --config apps/discovery/wrangler.jsonc
bunx wrangler deploy --config apps/discovery/wrangler.jsonc --env staging
bunx wrangler delete --config apps/discovery/wrangler.jsonc
bunx wrangler delete --config apps/discovery/wrangler.jsonc --env staging
```

`wrangler delete` asks for confirmation per script. The `releases-discovery`
and `releases-discovery-staging` workers.dev routes go with them.

## 2. Archive the Anthropic-side resources

In the Anthropic console, archive (do not delete, so session history stays
readable) for both environments:

- agents: `Released Discovery Agent`, `Released Worker Agent`,
  `Releases Discovery Coordinator`,
- environments: the `env_…` IDs that were in
  `managed-agents/{production,staging}.environment.yaml`,
- memory stores: errata and tool notes (`memstore_…`, formerly listed in
  `scripts/agent-skills{,.staging}.json` and, for errata, bound to the API as
  `MEMORY_STORE_ERRATA_ID`). The `PUT /v1/errata/:orgId` route that wrote to
  the errata store is removed in the same PR.

The IDs are in the git history of those files at the retirement merge's parent.

## 3. CLI

`releases admin discovery onboard` is a stub from CLI 0.79 on: it exits 1 and
points at `releases admin org create`, `releases admin source create`, the
`local-ingest` skill, and `releases.json` listing. `onboard apply` is gone. Cut
the CLI release after the API route is gone so the stub and the 404 land
together.
