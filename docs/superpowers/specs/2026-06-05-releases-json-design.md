# 2026-06-05 — `releases.json`: owner-declared listing metadata (Tier 1)

## Summary

Let an organization or repo owner self-declare how they appear in the Releases
registry by hosting a small, `$schema`-validated `releases.json` file, the way
[skills.sh](https://www.skills.sh/docs/customize) lets a repo owner drop a
`skills.sh.json` to customize their listing. The file is **owner-authored,
self-verifying, and presentation-scoped** — it never grants control over
ingest, editorial curation, or another owner's data.

This is **Tier 1: display/grouping metadata only.** Self-serve _source
declaration_ (an owner adding new changelog sources / fetch routing) is a
deliberately separate, gated follow-up (Tier 2) and is out of scope here.

Inspiration and the one deliberate divergence from skills.sh:

- skills.sh is repo/skill-centric and trusts the repo loosely (install
  telemetry ≈ "this repo is theirs"). Releases is **domain/org-centric**
  (`organizations.domain` is unique; we already resolve by domain). So our
  headline location is **domain-hosted** — and hosting on the domain _is_ the
  verification, something skills.sh's model cannot assert.
- skills.sh's file only groups _that repo's own items_ into sections; it does
  not define a global identity. Our **repo-hosted** file mirrors that exactly:
  it speaks only for its own source and maps it to a product. It does **not**
  govern the org.

## Authority is scoped by where the file is hosted

The central safety property: **what a file is allowed to change is determined by
where it is hosted, not by what it claims.** The two scopes touch disjoint
fields, so there is no cross-file merge/precedence problem.

| File location                                | Scope                     | Honored fields                                                                   | Why the authority holds                                                   |
| -------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `https://{domain}/.well-known/releases.json` | **Org identity**          | `name`, `description`, `category`, `avatar`, `tags`, `social`, `notice`          | Control of the domain on `organizations.domain` proves control of the org |
| `{owner}/{repo}/releases.json` (repo root)   | **This source → product** | `product` (`name`/`slug` + optional `description`, `category`, `kind`, `avatar`) | Control of the repo proves control of _that source only_                  |

The reconciler enforces scope by host: org-identity fields are honored **only**
from the domain file; a repo file's product mapping is honored **only** for that
repo's own source. A repo file that contains `name`/`description` has those keys
**ignored** — a repo structurally cannot define the org.

## File format

One file name (`releases.json`), one published `$schema`, two hosting contexts.
All fields are optional; an empty `{}` is a valid no-op. The schema documents
both scopes; the server honors the subset appropriate to the host.

### Org scope — `https://{domain}/.well-known/releases.json`

```jsonc
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "name": "Acme",
  "description": "CI for teams that ship.",
  "category": "developer-tools",
  "avatar": "https://acme.com/logo.png",
  "tags": ["ci", "observability"],
  "social": { "twitter": "acmehq", "github": "acme", "discord": "https://discord.gg/…" },
  "notice": { "message": "Docs moved", "href": "https://acme.com/docs" },
}
```

### Source/product scope — `{owner}/{repo}/releases.json`

```jsonc
{
  "$schema": "https://releases.sh/schemas/releases.json",
  "product": {
    "name": "Acme Cloud", // declares: this source belongs to product "Acme Cloud"
    "slug": "acme-cloud", // optional; slugified from name when omitted
    "description": "…", // optional, fill-if-empty
    "category": "cloud", // optional, fill-if-empty, validated against CATEGORIES
    "kind": "saas", // optional, fill-if-empty
  },
}
```

## Schema publishing (`$schema`)

- Define `ReleasesJsonConfigSchema` (zod) in a new
  `packages/api-types/src/schemas/well-known.ts`, reusing the existing
  `NoticeSchema` (`schemas/shared.ts`) and `CATEGORIES`/`CategorySchema`. Export
  the `ReleasesJsonConfig` type from `api-types.ts`.
- Generate the public JSON Schema with **zod 4's native `z.toJSONSchema()`**
  (the repo is on `zod ^4.4.3` — no new dependency). A small
  `scripts/gen-releases-json-schema.ts` writes committed output to
  `web/public/schemas/releases.json`, served statically at
  `https://releases.sh/schemas/releases.json` (Next.js already serves
  `web/public/.well-known/*` this way; the `schemas/` dir is new).
- Owners reference it via the `$schema` key for editor autocomplete + validation.
- Optional later: a CI `--check` mode on the gen script to fail on drift between
  the zod source and the committed JSON Schema (same pattern as the agent-YAML
  drift gate). Not required for v1.

## Fetch path (safe, fail-closed)

A `fetchReleasesJson(url)` helper that **reuses the SSRF primitives already
exported from `workers/api/src/lib/avatar-ingest.ts`** (`isPrivateOrLocalHost`,
`safeUrl`, manual-redirect + bounded-read pattern):

- HTTPS only; manual redirects, each hop SSRF-screened; same-host redirects only.
- 5s timeout (`AbortController`).
- **64 KB size cap** (bounded read).
- JSON only; lenient content-type, strict parse.

Every failure mode is a **safe no-op** with a `logEvent` and a reason — nothing
partial is ever applied:

| Condition               | Result                               |
| ----------------------- | ------------------------------------ |
| 404 / missing file      | skip (no-op)                         |
| network error / timeout | skip; retry next sweep               |
| non-JSON / invalid JSON | skip + log                           |
| body over size cap      | skip + log                           |
| SSRF-blocked host       | skip + log                           |
| zod validation failure  | skip + log with the validation error |

This matches the house rule: opt-out / safety gates fail closed; an ambiguous or
unparseable response yields the safe verdict, never "proceed."

## Reconciliation & precedence

Two pure reconcilers, both computing a field diff and applying it through
**existing** write helpers — no new write primitives.

Provenance is tracked with a `selfDeclared` marker so the reconciler can tell
its own past writes from curator edits:

```jsonc
// organizations.metadata.selfDeclared  (and source.metadata.selfDeclared)
{
  "fields": ["description", "category"],
  "source": "well-known",
  "configHash": "…",
  "syncedAt": "…",
}
```

Per-field rule (applied to every honored field):

1. **Field empty** → write it; add the field name to `selfDeclared.fields`.
2. **Field non-empty AND in `selfDeclared.fields`** → owner still owns it → update.
3. **Field non-empty AND NOT in `selfDeclared.fields`** → a curator set it → **never clobber** (skip).
4. **Editorial / operational fields are never touched** regardless: org
   `featured`, `isHidden`, `discovery`, `fetchPaused`, `autoGenerateContent`,
   `slug`, `domain`, aliases, collections, blocked/ignored URLs; source
   `isPrimary`, `isHidden`, `fetchPriority`.

`configHash` lets a re-sync short-circuit when the file is byte-identical to the
last applied version. Dropping a field from the file leaves the last value in
place (no auto-clear) to avoid surprise data loss.

### Org reconciler (`reconcileOrgFromConfig(org, config)`)

Applies org-identity fields via the existing helpers used by
`PATCH /v1/orgs/:slug` (`workers/api/src/routes/orgs.ts`):

- `name`, `description` → direct column writes (precedence rule above).
- `category` → `resolveCategoryInput(db, …)`; if it does not resolve, that one
  field is **ignored** (fail-closed) and the rest of the sync proceeds.
- `avatar` → mirrored to R2 via `ingestOrgAvatar` (`orgs/{slug}.{ext}`), reusing
  its SSRF guard / size cap; sets `organizations.avatarUrl`.
- `tags` → **additive** via `getOrCreateTagsD1` + `onConflictDoNothing` (v1 does
  not remove tags not in the file).
- `social` → **additive** upsert into `org_accounts` (`platform`, `handle`); v1
  does not delete accounts absent from the file (also sidesteps the global
  `UNIQUE(platform, handle)` constraint).
- `notice` → `setNoticeInMetadata` (validated by `NoticeSchema`).

### Source/product reconciler (`reconcileSourceFromConfig(source, config)`)

Repo path. For a `github` source whose `url` yields `owner/repo`:

- Resolve the product **within the source's org** by `slug` (slugified from
  `name` when `slug` omitted): find-or-create the `products` row, then set
  `source.productId`. **Same product slug across repos → same product row →
  grouped.** This grouping is the primary purpose of the repo file.
- Product display metadata (`description`, `category`, `kind`, `avatar`) is
  **fill-if-empty only** — never clobbers a curator value _or_ another repo's
  value, so two repos claiming the same product cannot fight over its fields.
  This is a deliberate simplification of the general per-field rule above: for
  product metadata, v1 does **not** track provenance per-repo, so even the
  declaring repo only fills _empty_ fields (it does not get the rule-#2
  "self-declared → update" behavior that org fields get). `avatar` mirrored to
  R2 (product avatar key). `category` validated; ignored if it does not resolve.
- Provenance recorded on `source.metadata.selfDeclared` (product association)
  and on the product (filled fields) so a curator reassigning the source or
  editing the product survives the next sync.

## Triggers

Both paths reuse the reconcilers; nothing else fires inference.

- **Route:** `POST /v1/orgs/:slug/sync-well-known` (write scope), supporting
  `?dryRun=1` to return the computed diff without applying — for owners/curators
  and for CLI smoke testing. (A per-source dry-run variant returns the product
  diff for one github source.)
- **Daily sweep** — a new cron module with a new daily slot in
  `workers/api/wrangler.jsonc` (`triggers.crons`), dispatched from `scheduled`
  in `workers/api/src/index.ts`. Two passes:
  1. **Org pass** — orgs with a `domain` set and not `fetchPaused` → fetch
     `.well-known/releases.json` → org reconciler.
  2. **Source pass** — `github` sources → fetch repo-root `releases.json` →
     source/product reconciler.
     Content-hash-gated to skip unchanged files. Cost is trivial (small JSON
     fetches, no AI).

### Feature flag

Gated behind a Flagship boolean `well-known-sync-enabled`, registered in
`@releases/lib/flags` and created in both Flagship apps
(`releases-platform{,-staging}`). **Default: on** — the sweep runs in prod out
of the box. The flag remains as a kill switch (evaluation order: Flagship →
wrangler var → default, failing open to the var). The on-demand route ignores
the flag (explicit owner/curator action is always allowed).

## Data model impact

**No schema migration.** Everything maps onto existing columns:

- Org identity → `organizations` columns + `org_accounts` + `org_tags` (all
  written today by existing routes).
- Provenance → `organizations.metadata.selfDeclared` / `source.metadata.selfDeclared`
  (JSON sub-key, like the existing `metadata.notice`).
- Product mapping → `products` (find-or-create) + `sources.productId` (existing).

Because `packages/core/src/schema.ts` is untouched, the schema-pairing CI gate
does not require a migration.

## Security & trust model

- A file is fetched only from an origin already bound to the entity: the org's
  `domain` (org file) or a repo backing an existing `github` source (repo file).
  An owner cannot point us at an arbitrary host.
- SSRF-guarded fetch (reused from `avatar-ingest.ts`); HTTPS only; size + time
  caps; same-host redirects.
- Avatars are mirrored to R2, never hotlinked from arbitrary URLs.
- The reconciler never overwrites curator-set or editorial fields, and a repo
  file can never reach org-identity fields.
- Fail-closed throughout: any ambiguity → no change.

## Testing

`bun test` + the existing `tests/db-helper.ts` D1 fixtures.

- **Schema (zod):** accept valid org/product files; reject malformed shapes,
  bad notice, oversized strings.
- **Org reconciler precedence matrix:** empty-fill; self-declared-update;
  curator-no-clobber; invalid-category-ignored-but-sync-proceeds;
  editorial-fields-untouched; tags/social additive (no removal).
- **Source/product reconciler:** create product + attach source; second repo
  with same slug groups onto the same product; product metadata fill-if-empty
  (no inter-repo clobber); curator reassignment survives re-sync.
- **Fetch path (mocked fetch):** 404 no-op; invalid JSON skip; oversize skip;
  SSRF-blocked host skip; valid file → reconcile.
- **Route:** `dryRun` returns a diff and applies nothing; live applies the diff.

## Out of scope (Tier 2 / future)

- Self-serve **source declaration** (`changelogs[]` / fetch routing) — the
  gated, money-spending follow-up.
- Org-identity from a repo file (intentionally never).
- Social/tag **removal** sync (v1 is additive).
- A domain file declaring a full **product list** for the org.
- Multi-product repos (`products[]`), `isPrimary` declaration.
- A CLI verb in `releases-cli` and a public web docs page mirroring
  `skills.sh/docs/customize` (easy adds; not in this pass).

## Build sequence (high level)

1. `ReleasesJsonConfigSchema` (zod) in api-types + the gen script + committed
   `web/public/schemas/releases.json`.
2. `fetchReleasesJson` safe-fetch helper (reuse SSRF primitives).
3. `reconcileOrgFromConfig` + `reconcileSourceFromConfig` (pure, unit-tested).
4. `POST /v1/orgs/:slug/sync-well-known` route (+ dryRun).
5. Daily two-pass sweep cron + `well-known-sync-enabled` flag (default on).
6. Tests, `docs/architecture/well-known-config.md`, AGENTS.md one-liner,
   example file.
