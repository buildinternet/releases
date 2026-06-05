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
  files), gated by the Flagship flag `well-known-sync-enabled` (**default on**;
  it is a kill switch). The schema is generated from the api-types zod source via
  `bun run gen:releases-schema` and served at
  `https://releases.sh/schemas/releases.json`.

## Out of scope (Tier 2 / future)

Self-serve source declaration (`changelogs[]`), org-identity from a repo file,
social/tag removal sync, a CLI verb, and a public web docs page.
