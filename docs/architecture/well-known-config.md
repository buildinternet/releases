# Owner-declared listing metadata (`releases.json`)

Owners self-declare how they appear in the registry with a small,
`$schema`-validated `releases.json`. Authority is scoped by **where the file is
hosted**, not by what it claims.

| Location                                     | Scope                 | Honored fields                                                          |
| -------------------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `https://{domain}/.well-known/releases.json` | Org identity          | `name`, `description`, `category`, `avatar`, `tags`, `social`, `notice` |
| `{owner}/{repo}/releases.json` (repo root)   | That source → product | `product` (name/slug + optional description/category/kind)              |

The reconciler honors org-identity keys only from the domain file and `product`
only from a repo file — a repo cannot define the org. Same product slug across
repos groups those sources under one product.

## Org-scope example (`.well-known/releases.json`)

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "name": "Acme",
  "description": "CI for teams that ship.",
  "category": "developer-tools",
  "avatar": "https://acme.com/logo.png",
  "tags": ["ci", "observability"],
  "social": { "twitter": "acmehq", "github": "acme" },
  "notice": { "message": "Docs moved", "href": "https://acme.com/docs" }
}
```

## Repo-scope example (`releases.json` at repo root)

```json
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "product": { "name": "Acme Cloud", "slug": "acme-cloud", "category": "cloud", "kind": "platform" }
}
```

## Reconciliation

- **Precedence:** a field is owner-writable only if it is empty or was previously
  self-declared (tracked at `metadata.selfDeclared`). Curator-set and editorial
  fields (`featured`, `isHidden`, `discovery`, `fetchPaused`, collections,
  blocked/ignored URLs; source `isPrimary`/`fetchPriority`) are never touched.
- **`name` in practice:** an org's `name` is required at creation and never
  empty, so the domain file's `name` is honored only for the (rare) nameless org
  — an existing name is never overwritten. It stays in the honored set so a
  future nameless-org path keeps working, but expect it to no-op in practice.
- **Category** is validated against `CATEGORIES`; an unresolvable value is
  ignored without failing the sync.
- **Tags/social** are additive (v1 does not remove entries absent from the file).
- **Product metadata** is fill-if-empty across repos, so two repos claiming the
  same product cannot fight over its fields.
- Everything **fails closed**: a missing/invalid/oversized/SSRF-blocked file is a
  safe no-op.

## Triggers

- `POST /v1/orgs/:slug/sync-well-known` (write scope), `?dryRun=1` to preview.
- Daily sweep (`0 6 * * *`), two passes (org domain files, then github repo
  files). The schema is generated from the api-types zod source via
  `bun run gen:releases-schema` and served at
  `https://releases.sh/schemas/releases.json`.

### Sweep capping + due-filtering (#1440)

Each pass issues one outbound fetch per entity (the org pass can cost a second
for an avatar mirror), so an uncapped sweep would cross Cloudflare's
1000-subrequest-per-invocation ceiling as the corpus grows. The sweep is
self-limiting:

- **Due-filter.** Each entity carries `metadata.wellKnownSweptAt`, stamped via
  `json_set` after the reconciler returns on **every** outcome (applied,
  unchanged, fetch-skipped, errored) — a clock distinct from
  `metadata.selfDeclared.syncedAt`, which only advances on a successful apply.
  An entity swept within `WELL_KNOWN_SWEEP_INTERVAL_HOURS` (default **168 / 7
  days**) is skipped; never-swept rows (`NULL`) are always due.
- **Hard cap, oldest-first.** Each pass processes at most
  `WELL_KNOWN_MAX_PER_RUN` (default **250**) entities, ordered by
  `wellKnownSweptAt ASC` (NULLs first). Worst-case subrequests are
  `cap × 2 + cap = cap × 3` (≤ 750 at the default), comfortably under the
  ceiling. Because deferred rows are the oldest, they lead the next run, so the
  whole corpus is covered across runs rather than starving the tail.
- **No silent caps.** The `sweep-done` event logs `orgProcessed` /
  `sourceProcessed` and `orgCapped` / `sourceCapped` so a backlog is visible.

Both knobs are numeric env vars (intentionally not Flagship), with a floor of 1
and a fallback to the default on an invalid value.

## Out of scope (Tier 2 / future)

Self-serve source declaration (`changelogs[]`), org-identity from a repo file,
social/tag removal sync, a CLI verb, and a public web docs page.
